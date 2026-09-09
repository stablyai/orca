import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { AgentSessionRewindRefusal } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type {
  StructuredAgentSessionAdapter,
  StructuredAgentSessionAcquireInput,
  AgentSessionDispatchOutcome
} from './structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const caller = { callerKey: 'desktop' }
let directory: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let sink: StructuredAgentSessionEventSink
let adapter: StructuredAgentSessionAdapter
let acquires: StructuredAgentSessionAcquireInput[]
const rewind = vi.fn<NonNullable<StructuredAgentSessionAdapter['rewind']>>()
const recoverRewind = vi.fn<NonNullable<StructuredAgentSessionAdapter['recoverRewind']>>()
let failClaude = false

beforeEach(async () => {
  resetHostTestOperationIds()
  rewind.mockReset().mockResolvedValue({ ok: true })
  recoverRewind.mockReset().mockResolvedValue({
    ok: true,
    items: [
      {
        identity: { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: 'kept', ordinal: 0 },
        body: hostTestMessage('verified history')
      }
    ]
  })
  failClaude = false
  acquires = []
  directory = await mkdtemp(join(tmpdir(), 'orca-rewind-'))
  store = await AgentSessionRecordStore.open({
    directory: join(directory, 'store'),
    hostId: 'local'
  })
  adapter = {
    supportsCreate: (_location, agent) => agent === 'codex' || agent === 'claude',
    supportsLocation: () => true,
    acquire: async (input) => {
      acquires.push(input)
      if (input.rewind && failClaude) {
        throw new AgentSessionRewindRefusal('provider-refused')
      }
      if (input.rewind) {
        await input.rewind.onProved?.(input.rewind.targetUuid)
      }
      await input.rewindRecovery?.onProved()
      sink = input.events!
      const handle = input.identity.providerHandle
      return {
        process: {
          hostId: 'local',
          pid: 4000 + acquires.length,
          processStartTimeMs: HOST_TEST_NOW,
          spawnToken: input.spawnToken
        },
        acquisitionGeneration: `generation-${acquires.length}`,
        link: {
          linkId: `link-${acquires.length}`,
          mintedAtFence: input.fence,
          observedAt: HOST_TEST_NOW,
          origin: acquires.length === 1 ? 'created' : 'resumed',
          handle:
            handle.kind === 'claude'
              ? {
                  provider: 'claude',
                  sessionId: handle.sessionId,
                  leafUuid: input.rewind?.targetUuid ?? 'tip'
                }
              : { provider: 'codex', threadId: HOST_TEST_THREAD }
        }
      }
    },
    dispatch: vi.fn(async (): Promise<AgentSessionDispatchOutcome> => ({
      state: 'unknown',
      reason: 'test'
    })),
    cancelTurn: async () => ({ cancelled: false }),
    answerPrompt: async () => {},
    setOption: async () => {},
    rewindSupport: () => ({ supported: true }),
    rewind,
    recoverRewind,
    releaseAcquisition: async () => true,
    closeSession: async () => true
  }
  host = new StructuredAgentSessionHost({
    store,
    adapter,
    journalRoot: directory,
    claimKeyId: 'key',
    now: () => HOST_TEST_NOW,
    probeOwner: async () => ({ outcome: 'exit-observed' })
  })
})
afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(directory, { recursive: true, force: true })
})

async function seed(provider: 'codex' | 'claude' = 'codex', acceptedSubmissions = false) {
  const params =
    provider === 'codex'
      ? hostTestAttachParams(null)
      : hostTestAttachParams(null, {
          provider,
          agent: provider,
          accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/claude' },
          providerHandle: { kind: 'claude', sessionId: 'claude-session', leafUuid: 'tip' }
        })
  expect(await host.attach(caller, params)).toMatchObject({ ok: true })
  const keys = ['kept', 'drop', 'tip'].map((uuid) =>
    provider === 'codex'
      ? { provider, threadId: HOST_TEST_THREAD, turnId: uuid, ordinal: 0 }
      : { provider, sessionId: 'claude-session', uuid }
  )
  let selectedItemId = agentJournalItemKey(keys[1]!)
  for (const [i, identity] of keys.entries()) {
    const body = {
      ...hostTestMessage(String(i)),
      role: i === 2 ? ('assistant' as const) : ('user' as const)
    }
    if (acceptedSubmissions && i !== 2) {
      const clientOperationId = hostTestOperationId()
      vi.mocked(adapter.dispatch).mockResolvedValueOnce({
        state: 'accepted',
        providerIdentity: identity
      })
      expect(
        await host.send(caller, {
          body,
          envelope: {
            sessionId: HOST_TEST_SESSION,
            clientOperationId,
            expectedRuntimeFence: store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
            payloadFingerprint: computeAgentSessionPayloadFingerprint({
              method: 'agentSession.send',
              sessionId: HOST_TEST_SESSION,
              fields: { body }
            })
          }
        })
      ).toMatchObject({ ok: true })
      if (i === 1) {
        selectedItemId = agentJournalSubmissionKey(clientOperationId)
      }
    } else {
      sink.appendItem(identity, body)
    }
  }
  await host.flushStreamedEvents(HOST_TEST_SESSION)
  return selectedItemId
}
function params(
  itemId: string,
  expectedEpoch = host.journalSnapshot(HOST_TEST_SESSION).cursor.epoch
) {
  return {
    itemId,
    expectedEpoch,
    envelope: {
      sessionId: HOST_TEST_SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.rewind',
        sessionId: HOST_TEST_SESSION,
        fields: { itemId, expectedEpoch }
      })
    }
  }
}

describe('host rewind', () => {
  it.each(['codex', 'claude'] as const)(
    'resolves accepted %s user submissions to provider targets',
    async (provider) => {
      const target = await seed(provider, true)
      expect(target.startsWith('orca:')).toBe(true)
      expect(await host.rewind(caller, params(target))).toMatchObject({ ok: true })
      expect(host.journalSnapshot(HOST_TEST_SESSION).items).toHaveLength(1)
      if (provider === 'codex') {
        expect(rewind).toHaveBeenCalledWith(expect.objectContaining({ beforeTurnId: 'drop' }))
      } else {
        expect(acquires[1]?.rewind).toMatchObject({ targetUuid: 'kept', dropsTurn: 'drop' })
      }
    }
  )

  it('retains the preceding accepted Claude prompt when rewinding its assistant response', async () => {
    await seed('claude', true)
    const target = agentJournalItemKey({
      provider: 'claude',
      sessionId: 'claude-session',
      uuid: 'tip'
    })
    expect(await host.rewind(caller, params(target))).toMatchObject({ ok: true })
    expect(acquires[1]?.rewind).toMatchObject({ targetUuid: 'drop' })
    expect(host.journalSnapshot(HOST_TEST_SESSION).items).toHaveLength(2)
  })
  it('finishes a durable provider success on reattach without repeating the provider mutation', async () => {
    const target = await seed()
    const request = params(target)
    const replace = vi
      .spyOn(AgentSessionJournal.prototype, 'replaceEpochItems')
      .mockRejectedValueOnce(new Error('disk failed'))
    await expect(host.rewind(caller, request)).rejects.toThrow('disk failed')
    expect(store.getRecord(HOST_TEST_SESSION)?.rewind?.phase).toBe('provider-succeeded')
    replace.mockRestore()
    const fence = store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence
    expect(await host.attach(caller, hostTestAttachParams(fence))).toMatchObject({ ok: true })
    expect(host.journalSnapshot(HOST_TEST_SESSION).items).toHaveLength(1)
    expect(store.getRecord(HOST_TEST_SESSION)?.rewind?.phase).toBe('completed')
    expect(await host.rewind(caller, request)).toMatchObject({ ok: true, replayed: true })
    expect(rewind).toHaveBeenCalledTimes(1)
  })

  it('retries complete hydration after native acknowledgement without committing partial history', async () => {
    const target = await seed()
    const before = host.journalSnapshot(HOST_TEST_SESSION)
    rewind.mockImplementation(async (input) => {
      await input.onReverted?.()
      throw new Error('history unavailable')
    })
    await expect(host.rewind(caller, params(target))).rejects.toThrow('history unavailable')
    expect(host.journalSnapshot(HOST_TEST_SESSION)).toEqual(before)
    expect(store.getRecord(HOST_TEST_SESSION)?.rewind).toMatchObject({
      phase: 'prepared',
      providerApplied: true
    })
    recoverRewind.mockRejectedValueOnce(new Error('history still unavailable'))
    await expect(
      host.attach(
        caller,
        hostTestAttachParams(store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence)
      )
    ).rejects.toThrow('history still unavailable')
    expect(store.getRecord(HOST_TEST_SESSION)?.rewind?.phase).toBe('prepared')
    expect(
      await host.attach(
        caller,
        hostTestAttachParams(store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence)
      )
    ).toMatchObject({ ok: true })
    expect(host.journalSnapshot(HOST_TEST_SESSION).items).toHaveLength(1)
    expect(host.journalSnapshot(HOST_TEST_SESSION).items[0]?.body).toEqual(
      hostTestMessage('verified history')
    )
    expect(recoverRewind).toHaveBeenCalledTimes(2)
    expect(rewind).toHaveBeenCalledTimes(1)
  })
  it('fences stale owners and the second of two concurrent rewinds', async () => {
    const target = await seed()
    const stale = params(target)
    stale.envelope.expectedRuntimeFence++
    expect(await host.rewind(caller, stale)).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_checkpoint_stale' }
    })
    let finish!: () => void
    rewind.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ ok: true })
        })
    )
    const first = host.rewind(caller, params(target))
    const second = host.rewind(caller, params(target))
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    finish()
    expect(await first).toMatchObject({ ok: true })
    expect(await second).toMatchObject({ ok: false, refusal: { rewindReason: 'stale-epoch' } })
    expect(rewind).toHaveBeenCalledTimes(1)
  })
  it('replaces the epoch with the retained prefix and replays without another provider call', async () => {
    const target = await seed()
    const request = params(target)
    const result = await host.rewind(caller, request)
    expect(result).toMatchObject({ ok: true })
    expect(host.journalSnapshot(HOST_TEST_SESSION).items).toHaveLength(1)
    expect(host.journalSnapshot(HOST_TEST_SESSION).cursor.epoch).not.toBe(request.expectedEpoch)
    expect(await host.rewind(caller, request)).toMatchObject({ ok: true, replayed: true })
    expect(rewind).toHaveBeenCalledTimes(1)
  })
  it('reacquires Claude at the retained cursor with the same session and a new lease fence', async () => {
    const target = await seed('claude')
    const before = store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence
    expect(await host.rewind(caller, params(target))).toMatchObject({ ok: true })
    const emit = vi.fn()
    const unsubscribe = host.subscribe({ id: 'after-rewind', sessionId: HOST_TEST_SESSION, emit })
    emit.mockClear()
    sink.appendItem(
      { provider: 'claude', sessionId: 'claude-session', uuid: 'next' },
      hostTestMessage('next')
    )
    sink.publish()
    await host.flushStreamedEvents(HOST_TEST_SESSION)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'batch' }))
    unsubscribe()
    expect(acquires[1]?.rewind).toMatchObject({
      targetUuid: 'kept',
      previousLeafUuid: 'tip',
      dropsTurn: 'drop'
    })
    expect(store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence).toBeGreaterThan(before)
    expect(store.getRecord(HOST_TEST_SESSION)!.lease.ownerProcess?.pid).toBe(4002)
    expect(host.journalSnapshot(HOST_TEST_SESSION).items).toHaveLength(2)
  })
  it('recovers a Claude refusal with one plain resume and preserves the journal', async () => {
    const target = await seed('claude')
    failClaude = true
    const before = host.journalSnapshot(HOST_TEST_SESSION)
    expect(await host.rewind(caller, params(target))).toMatchObject({
      ok: false,
      refusal: { rewindReason: 'provider-refused' }
    })
    expect(acquires).toHaveLength(3)
    expect(acquires[2]?.rewind).toBeUndefined()
    expect(host.journalSnapshot(HOST_TEST_SESSION)).toEqual(before)
    expect(store.getRecord(HOST_TEST_SESSION)!.lease.claimStatus).toBe('live')
  })
  it('refuses a rewind racing an active turn before provider execution', async () => {
    const target = await seed()
    sink.appendItem(
      { provider: 'orca', clientMessageId: 'active' },
      { kind: 'status', text: 'working', turnLifecycle: { turnId: 'active', state: 'running' } }
    )
    expect(await host.rewind(caller, params(target))).toMatchObject({
      ok: false,
      refusal: { rewindReason: 'busy' }
    })
    expect(rewind).not.toHaveBeenCalled()
  })
  it('refuses stale epochs and targets from another provider', async () => {
    const target = await seed()
    expect(await host.rewind(caller, params(target, 'old-epoch'))).toMatchObject({
      ok: false,
      refusal: { rewindReason: 'stale-epoch' }
    })
    expect(await host.rewind(caller, params('claude:foreign'))).toMatchObject({
      ok: false,
      refusal: { rewindReason: 'invalid-target' }
    })
    expect(rewind).not.toHaveBeenCalled()
  })
  it('keeps a failed hydration epoch intact and blocks sends and duplicate rewind', async () => {
    const target = await seed()
    const request = params(target)
    const before = host.journalSnapshot(HOST_TEST_SESSION)
    rewind.mockRejectedValue(new Error('hydration failed'))
    await expect(host.rewind(caller, request)).rejects.toThrow('hydration failed')
    expect(host.journalSnapshot(HOST_TEST_SESSION)).toEqual(before)
    expect(await host.rewind(caller, request)).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_unknown' }
    })
    const body = hostTestMessage('new prompt')
    const envelope = {
      ...params(target).envelope,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: HOST_TEST_SESSION,
        fields: { body }
      })
    }
    expect(await host.send(caller, { envelope, body })).toMatchObject({
      ok: false,
      refusal: { rewindReason: 'outcome-unknown' }
    })
    expect(adapter.dispatch).not.toHaveBeenCalled()
    expect(
      await host.attach(
        caller,
        hostTestAttachParams(store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence)
      )
    ).toMatchObject({ ok: true })
    expect(store.getRecord(HOST_TEST_SESSION)?.rewind?.phase).toBe('completed')
    expect(await host.rewind(caller, request)).toMatchObject({ ok: true, replayed: true })
    expect(rewind).toHaveBeenCalledTimes(1)
  })

  it('clears an unapplied prepared rewind after observing the target still present', async () => {
    const target = await seed()
    const before = host.journalSnapshot(HOST_TEST_SESSION)
    rewind.mockRejectedValueOnce(new Error('read failed before revert'))
    await expect(host.rewind(caller, params(target))).rejects.toThrow('read failed')
    recoverRewind.mockResolvedValueOnce({ ok: false, reason: 'provider-refused' })
    expect(
      await host.attach(
        caller,
        hostTestAttachParams(store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence)
      )
    ).toMatchObject({ ok: true })
    expect(host.journalSnapshot(HOST_TEST_SESSION)).toEqual(before)
    expect(store.getRecord(HOST_TEST_SESSION)?.rewind?.phase).toBe('refused')
    expect(await host.rewind(caller, params(target))).toMatchObject({ ok: true })
  })

  it('recovers against the complete provider preflight when the local journal omitted an older turn', async () => {
    const target = await seed()
    const items = ['older', 'kept'].map((turnId) => ({
      identity: { provider: 'codex' as const, threadId: HOST_TEST_THREAD, turnId, ordinal: 0 },
      body: hostTestMessage(turnId)
    }))
    rewind.mockImplementationOnce(async (input) => {
      await input.onPrepared?.(items)
      await input.onReverted?.()
      throw new Error('lost after revert')
    })
    await expect(host.rewind(caller, params(target))).rejects.toThrow('lost after revert')
    recoverRewind.mockResolvedValueOnce({ ok: true, items })
    expect(
      await host.attach(
        caller,
        hostTestAttachParams(store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence)
      )
    ).toMatchObject({ ok: true })
    expect(host.journalSnapshot(HOST_TEST_SESSION).items).toHaveLength(2)
    expect(store.getRecord(HOST_TEST_SESSION)?.rewind?.phase).toBe('completed')
  })

  it.each(['turn', 'item'] as const)(
    'never commits a recovered prefix that omits an expected retained %s',
    async (missing) => {
      const target = await seed()
      const before = host.journalSnapshot(HOST_TEST_SESSION)
      const items = [0, 1].map((ordinal) => ({
        identity: {
          provider: 'codex' as const,
          threadId: HOST_TEST_THREAD,
          turnId: 'kept',
          ordinal
        },
        body: hostTestMessage(String(ordinal))
      }))
      rewind.mockImplementationOnce(async (input) => {
        await input.onPrepared?.(items)
        throw new Error('reply lost')
      })
      await expect(host.rewind(caller, params(target))).rejects.toThrow('reply lost')
      recoverRewind.mockResolvedValueOnce({
        ok: true,
        items: missing === 'turn' ? [] : items.slice(0, 1)
      })
      const replace = vi.spyOn(AgentSessionJournal.prototype, 'replaceEpochItems')
      await expect(
        host.attach(
          caller,
          hostTestAttachParams(store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence)
        )
      ).rejects.toThrow('proof-mismatch')
      expect(replace).not.toHaveBeenCalled()
      replace.mockRestore()
      expect(store.getRecord(HOST_TEST_SESSION)?.rewind?.expectedEpoch).toBe(before.cursor.epoch)
      expect(store.getRecord(HOST_TEST_SESSION)?.rewind?.phase).toBe('prepared')
    }
  )

  it('settles the existing epoch after a crash between journal commit and record completion', async () => {
    const target = await seed()
    const request = params(target)
    const transition = store.transitionHandoff.bind(store)
    const checkpoint = vi
      .spyOn(store, 'transitionHandoff')
      .mockImplementation((sessionId, update) =>
        transition(sessionId, (record) => {
          const next = update(record)
          if (next.rewind?.phase === 'completed') {
            throw new Error('completion write failed')
          }
          return next
        })
      )
    await expect(host.rewind(caller, request)).rejects.toThrow('completion write failed')
    const committed = host.journalSnapshot(HOST_TEST_SESSION)
    expect(committed.cursor.epoch).not.toBe(request.expectedEpoch)
    checkpoint.mockRestore()
    const replace = vi.spyOn(AgentSessionJournal.prototype, 'replaceEpochItems')
    expect(
      await host.attach(
        caller,
        hostTestAttachParams(store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence)
      )
    ).toMatchObject({ ok: true })
    expect(host.journalSnapshot(HOST_TEST_SESSION)).toEqual(committed)
    expect(replace).not.toHaveBeenCalled()
    replace.mockRestore()
    expect(await host.rewind(caller, request)).toMatchObject({ ok: true, replayed: true })
  })
})
