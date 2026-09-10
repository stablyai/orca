import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import * as prefixSelection from '../../../shared/agent-session-prefix'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session-journal-types'
import type { AgentSessionForkSource } from '../../../shared/agent-session-fork'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  AgentSessionPreSpawnError,
  type StructuredAgentSessionAdapter,
  type StructuredAgentSessionAcquireInput
} from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import {
  HOST_TEST_NOW as NOW,
  hostTestAttachParams,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

const caller = { callerKey: 'fork-client' }
const roots: string[] = []
const hosts: StructuredAgentSessionHost[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const host of hosts.splice(0)) {
    await host.flushAllStreamedEvents()
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function setup(provider: 'claude' | 'codex' = 'codex') {
  const root = await mkdtemp(join(tmpdir(), 'orca-fork-host-'))
  roots.push(root)
  const store = await AgentSessionRecordStore.open({
    directory: join(root, 'store'),
    hostId: 'local'
  })
  const inputs = new Map<string, StructuredAgentSessionAcquireInput>()
  const identity = (turn: string, ordinal: number): AgentJournalItemIdentity =>
    provider === 'codex'
      ? { provider, threadId: 'parent-thread', turnId: turn, ordinal }
      : { provider, sessionId: 'parent-thread', uuid: `${turn}-${ordinal}` }
  const acquire = vi.fn<StructuredAgentSessionAdapter['acquire']>(async (input) => {
    inputs.set(input.identity.sessionId, input)
    const forked = Boolean(input.fork)
    const isChild = input.identity.sessionId === 'child-session'
    const handle =
      provider === 'codex'
        ? ({ provider, threadId: isChild ? 'child-thread' : 'parent-thread' } as const)
        : ({
            provider,
            sessionId: isChild ? 'child-thread' : 'parent-thread',
            leafUuid: forked ? input.fork!.throughId : 'turn-2-1'
          } as const)
    // Settlement TOMBSTONES a turn's lifecycle row, so a finished turn leaves none behind. A
    // fixture that appends `turnLifecycle.state: 'completed'` models no journal Orca can produce.
    if (!isChild) {
      for (const turn of ['turn-1', 'turn-2']) {
        input.events?.appendItem(identity(turn, 0), {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: `${turn} prompt` }]
        })
        input.events?.appendItem(identity(turn, 1), {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: `${turn} answer` }]
        })
      }
    }
    return {
      process: {
        hostId: 'local',
        pid: isChild ? 1235 : 1234,
        processStartTimeMs: NOW,
        spawnToken: input.spawnToken
      },
      link: {
        linkId: `${isChild ? 'child' : 'parent'}-${input.fence}`,
        handle,
        origin: store.getRecord(input.identity.sessionId)?.providerHandleChain.length
          ? 'resumed'
          : 'created',
        mintedAtFence: input.fence,
        observedAt: NOW
      }
    }
  })
  const dispatch = vi.fn<StructuredAgentSessionAdapter['dispatch']>(async ({ sessionId }) => {
    const input = inputs.get(sessionId)!
    input.events?.appendItem(identity('turn-3', 1), {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Third answer' }]
    })
    return { state: 'accepted', providerIdentity: identity('turn-3', 0) }
  })
  const adapter: StructuredAgentSessionAdapter = {
    acquire,
    forkSupport: () => ({ supported: true }),
    dispatch,
    releaseAcquisition: async () => true,
    closeSession: async () => true,
    cancelTurn: async () => ({ cancelled: false }),
    answerPrompt: async () => {},
    setOption: async () => {}
  }
  let spawn = 0
  const host = new StructuredAgentSessionHost({
    store,
    adapter,
    journalRoot: root,
    claimKeyId: 'key',
    mintSpawnToken: () => `spawn-${++spawn}`,
    now: () => NOW
  })
  hosts.push(host)
  const params = hostTestAttachParams(null, {
    provider,
    agent: provider,
    providerHandle: undefined,
    accountHome: { variable: provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR', path: root }
  })
  expect(await host.attach(caller, params)).toMatchObject({ ok: true })
  const source: AgentSessionForkSource = {
    sessionId: params.envelope.sessionId,
    itemId: agentJournalItemKey(identity('turn-1', 1)),
    expectedEpoch: host.journalSnapshot(params.envelope.sessionId).cursor.epoch,
    expectedRuntimeFence: 1
  }
  const child: AgentSessionAttachParams = {
    ...params,
    envelope: {
      ...params.envelope,
      sessionId: 'child-session',
      clientOperationId: hostTestOperationId()
    }
  }
  child.envelope.payloadFingerprint = computeAgentSessionPayloadFingerprint({
    method: 'agentSession.attach',
    sessionId: 'child-session',
    fields: attachFingerprintFields(child)
  })
  return { host, store, params, child, source, acquire, inputs, identity }
}

describe('fork from a structured turn', () => {
  it('leaves the parent conversation usable while the child is still coming up', async () => {
    const { host, store, params, child, source, acquire } = await setup()
    // The child's provider bring-up is a process spawn plus a paginated history read; hold it open
    // and prove the parent is not queued behind it.
    let releaseChild = (): void => {}
    const childEntered = new Promise<void>((resolveEntered) => {
      const realAcquire = acquire.getMockImplementation()!
      acquire.mockImplementation(async (input) => {
        if (input.identity.sessionId !== 'child-session') {
          return realAcquire(input)
        }
        resolveEntered()
        await new Promise<void>((resolveHeld) => {
          releaseChild = resolveHeld
        })
        return realAcquire(input)
      })
    })

    const forking = host.fork(caller, child, source)
    await childEntered

    const parentId = params.envelope.sessionId
    const cancelEnvelope: AgentSessionMutationEnvelope = {
      sessionId: parentId,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(parentId)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.cancel',
        sessionId: parentId,
        fields: { turnId: 'turn-2' }
      })
    }
    // Settles while the fork is still held: under a source-wide lock this would deadlock the test.
    const cancelled = await Promise.race([
      host.cancel(caller, { envelope: cancelEnvelope, turnId: 'turn-2' }),
      forking.then(() => 'fork-finished-first' as const)
    ])
    expect(cancelled).toMatchObject({ ok: true })

    releaseChild()
    expect(await forking).toMatchObject({ ok: true })
  })

  it('keeps an unknown retained message role visible in the seeded child history', async () => {
    const { host, child, source } = await setup()
    vi.spyOn(prefixSelection, 'selectAgentSessionPrefix').mockReturnValueOnce({
      ok: true,
      retained: [
        {
          itemId: source.itemId,
          body: {
            kind: 'message',
            role: 'future-role',
            blocks: [{ type: 'text', text: 'Retained future message' }]
          },
          observedAt: NOW
        }
      ],
      providerItemId: source.itemId,
      throughId: 'turn-1',
      beforeTurnId: 'turn-1'
    })
    expect(await host.fork(caller, child, source)).toMatchObject({ ok: true })
    expect(host.journalSnapshot('child-session').items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: {
            kind: 'message',
            role: 'system',
            blocks: [{ type: 'text', text: 'Retained future message' }]
          }
        })
      ])
    )
  })

  it.each(['codex', 'claude'] as const)(
    'creates an independent %s session and leaves the parent unchanged',
    async (provider) => {
      const { host, store, child, source, acquire } = await setup(provider)
      const parent = structuredClone(store.getRecord(source.sessionId))
      const snapshot = host.journalSnapshot(source.sessionId)
      const [result, duplicate] = await Promise.all([
        host.fork(caller, child, source),
        host.fork(caller, child, source)
      ])
      expect(duplicate).toMatchObject({ ok: true, replayed: true })
      expect(result).toMatchObject({ ok: true, value: { sessionId: 'child-session' } })
      expect(store.getRecord(source.sessionId)).toEqual(parent)
      expect(host.journalSnapshot(source.sessionId)).toEqual(snapshot)
      const forked = store.getRecord('child-session')!
      expect(forked.lease.ownerProcess?.spawnToken).not.toBe(parent?.lease.ownerProcess?.spawnToken)
      expect(forked.providerHandleChain.map((link) => link.origin)).toEqual(['adopted', 'forked'])
      expect(
        host.journalSnapshot('child-session').items.filter((item) => item.body.kind === 'message')
      ).toHaveLength(2)
      expect(host.journalSnapshot('child-session').cursor.epoch).not.toBe(snapshot.cursor.epoch)
      expect(await host.fork(caller, child, source)).toMatchObject({ ok: true, replayed: true })
      expect(acquire.mock.calls.filter(([input]) => input.fork)).toHaveLength(1)
    }
  )

  it('refuses an in-progress turn before creating a record or calling the provider', async () => {
    const { host, store, child, source, inputs, acquire, identity } = await setup()
    inputs
      .get(source.sessionId)!
      .events!.appendItem(
        { provider: 'orca', clientMessageId: 'running' },
        { kind: 'status', text: 'Working', turnLifecycle: { turnId: 'turn-2', state: 'running' } }
      )
    const result = await host.fork(caller, child, {
      ...source,
      itemId: agentJournalItemKey(identity('turn-2', 1))
    })
    expect(result).toMatchObject({ ok: false })
    expect(store.getRecord('child-session')).toBeNull()
    expect(acquire).toHaveBeenCalledTimes(1)
  })

  it('refuses stale epochs and provider changes', async () => {
    const { host, child, source, acquire } = await setup()
    expect(await host.fork(caller, child, { ...source, expectedEpoch: 'stale' })).toMatchObject({
      ok: false
    })
    expect(
      await host.fork(caller, { ...child, provider: 'claude', agent: 'claude' }, source)
    ).toMatchObject({ ok: false })
    expect(acquire).toHaveBeenCalledTimes(1)
  })

  it('does not publish a visible empty session when the fork outcome is unknown', async () => {
    const { host, store, child, source, acquire } = await setup()
    acquire.mockImplementationOnce(async () => {
      throw new Error('provider response lost')
    })
    await expect(host.fork(caller, child, source)).rejects.toThrow('provider response lost')
    expect(store.getRecord('child-session')?.fork?.phase).toBe('attempted')
    expect(store.getVisibleSessionTabIndex().sessionIds).not.toContain('child-session')
    expect(host.hasSession('child-session')).toBe(false)
    // The ambiguity guard: the provider may hold a child, so the retry must never make a second.
    expect(await host.fork(caller, child, source)).toMatchObject({ ok: false })
    expect(acquire).toHaveBeenCalledTimes(2)
  })

  it('recovers a fork whose launch failed before any provider session existed', async () => {
    const { host, store, child, source, acquire } = await setup()
    acquire.mockImplementationOnce(async () => {
      throw new AgentSessionPreSpawnError(new Error('managed account is switching'))
    })
    await expect(host.fork(caller, child, source)).rejects.toThrow('managed account is switching')
    // Settled, not stranded — and the dead prefix is dropped rather than rewritten on every
    // lease renewal for the life of the record.
    expect(store.getRecord('child-session')?.fork).toMatchObject({
      phase: 'refused',
      retained: []
    })
    expect(await host.fork(caller, child, source)).toMatchObject({ ok: true })
    expect(host.journalSnapshot('child-session').items).not.toHaveLength(0)
    expect(acquire.mock.calls.filter(([input]) => input.fork)).toHaveLength(2)
  })

  it('resumes the proved child when journal publication fails instead of forking again', async () => {
    const { host, child, source, acquire, store } = await setup()
    const replace = vi
      .spyOn(AgentSessionJournal.prototype, 'replaceEpochItems')
      .mockRejectedValueOnce(new Error('journal unavailable'))
    await expect(host.fork(caller, child, source)).rejects.toThrow('journal unavailable')
    expect(store.getRecord('child-session')?.fork?.phase).toBe('provider-succeeded')
    expect(host.hasSession('child-session')).toBe(false)
    replace.mockRestore()
    expect(await host.fork(caller, child, source)).toMatchObject({ ok: true })
    expect(acquire.mock.calls.filter(([input]) => input.fork)).toHaveLength(1)
    expect(host.journalSnapshot('child-session').items).not.toHaveLength(0)
  })

  it('seeds the accepted user message using its provider identity', async () => {
    const { host, params, source, child, identity } = await setup()
    const body = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Third prompt' }]
    } as const
    const envelope = {
      sessionId: source.sessionId,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: 1,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: source.sessionId,
        fields: { body }
      })
    }
    await host.send(caller, { envelope, body: { ...body, blocks: [...body.blocks] } })
    await host.flushStreamedEvents(source.sessionId)
    const snapshot = host.journalSnapshot(params.envelope.sessionId)
    const accepted = snapshot.submissions.find(
      (entry) => entry.providerItemId === agentJournalItemKey(identity('turn-3', 0))
    )!
    expect(accepted).toBeDefined()
    const userItem = snapshot.items.find(
      (item) =>
        item.body.kind === 'message' &&
        item.body.role === 'user' &&
        item.itemId.includes(accepted.clientMessageId)
    )
    const selected = userItem?.itemId ?? agentJournalItemKey(identity('turn-3', 0))
    expect(await host.fork(caller, child, { ...source, itemId: selected })).toMatchObject({
      ok: true
    })
    expect(
      host
        .journalSnapshot('child-session')
        .items.some((item) => item.itemId === 'codex:child-thread:turn-3:0')
    ).toBe(true)
  })
})
