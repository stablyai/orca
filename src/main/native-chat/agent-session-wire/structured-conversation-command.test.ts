import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS } from '../../../shared/agent-session-host-authority'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionConversationCommand } from '../../../shared/agent-session-conversation-command'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  AgentSessionAcquisitionRefusal,
  type StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import { STRUCTURED_AGENT_SESSION_IDLE_MS } from './structured-agent-session-idle-sweep'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'

const caller = { callerKey: 'desktop' }
let directory: string
let generation: number
let clock: number
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let hosts: StructuredAgentSessionHost[]
let adapter: StructuredAgentSessionAdapter
const compact = vi.fn<NonNullable<StructuredAgentSessionAdapter['compact']>>()
let acquisitions = 0

function envelope(method: string, fields: Record<string, unknown>) {
  return {
    sessionId: HOST_TEST_SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: HOST_TEST_SESSION,
      fields
    })
  }
}

function commandParams(command: AgentSessionConversationCommand) {
  return { command, envelope: envelope('agentSession.conversationCommand', { command }) }
}

function sendParams(text: string) {
  const body = hostTestMessage(text)
  return { body, envelope: envelope('agentSession.send', { body }) }
}

const generationRoot = () => join(directory, `generation-${generation}`)

let ownerProbe: AgentSessionOwnerProbe = { outcome: 'pid-absent' }

async function openHost(): Promise<void> {
  store = await openTestAgentSessionRecordStore(generationRoot())
  host = new StructuredAgentSessionHost({
    store,
    adapter,
    journalDatabase: openTestJournalHostDatabase(generationRoot()),
    claimKeyId: 'key',
    now: () => clock,
    mintSpawnToken: () => `spawn-${acquisitions}`,
    // The owners a restarted host finds died with the process that started them, unless a test says otherwise.
    probeOwner: async () => ownerProbe
  })
  hosts.push(host)
}

/** A crash and relaunch: the next host opens what the dying one had written, and nothing after. */
async function restartHost(): Promise<void> {
  await store.renewLeases([])
  const dying = generationRoot()
  generation++
  await cp(dying, generationRoot(), {
    recursive: true,
    filter: (source) => !source.endsWith('.tmp') && !source.includes('.lock')
  })
  await openHost()
}

beforeEach(async () => {
  resetHostTestOperationIds()
  ownerProbe = { outcome: 'pid-absent' }
  acquisitions = 0
  generation = 0
  clock = HOST_TEST_NOW
  hosts = []
  compact.mockReset().mockResolvedValue({ state: 'accepted', providerIdentity: null })
  directory = await mkdtemp(join(tmpdir(), 'orca-conversation-command-'))
  adapter = {
    supportsLocation: (location) =>
      location.executionHostId === 'local' && location.wslDistro === null,
    acquire: vi.fn(async (input) => {
      acquisitions++
      return {
        process: {
          hostId: 'local',
          pid: 4000 + acquisitions,
          processStartTimeMs: HOST_TEST_NOW,
          spawnToken: input.spawnToken
        },
        link: {
          linkId: `link-${acquisitions}`,
          mintedAtFence: input.fence,
          observedAt: HOST_TEST_NOW,
          origin: input.fence > 1 ? ('resumed' as const) : ('created' as const),
          handle: {
            provider: 'codex' as const,
            threadId:
              input.identity.providerHandle.kind === 'codex'
                ? input.identity.providerHandle.threadId
                : `00000000-0000-4000-8000-${String(acquisitions).padStart(12, '0')}`
          }
        }
      }
    }),
    dispatch: vi.fn(async () => ({ state: 'unknown' as const, reason: 'test' })),
    cancelTurn: vi.fn(async () => ({ cancelled: true })),
    answerPrompt: async () => {},
    setOption: async () => {},
    compact,
    releaseAcquisition: vi.fn(async () => true),
    closeSession: vi.fn(async () => true),
    readOptions: async () => ({ models: [], current: { model: 'test-model', effort: 'high' } })
  }
  await openHost()
  expect(
    await host.attach(caller, hostTestAttachParams(null, { options: { effort: 'low' } }))
  ).toMatchObject({ ok: true })
  await host.setSessionTabVisibility(HOST_TEST_SESSION, true)
})

afterEach(async () => {
  for (const each of hosts) {
    await each.flushAllStreamedEvents()
  }
  await rm(directory, { recursive: true, force: true })
})

describe('host conversation commands', () => {
  it('adopts the reported Fast preference into the replacement record', async () => {
    adapter.readOptions = async () => ({
      models: [],
      current: { model: 'test-model', effort: 'high', fastMode: false }
    })
    const result = await host.conversationCommand(caller, commandParams('clear'))
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(store.getRecord(result.value.replacementSessionId!)).toMatchObject({
      options: { model: 'test-model', effort: 'high', fastMode: 'false' }
    })
  })

  // What the child reports can be a value it fell back to, such as a model whose restore write it
  // never answered; the replacement's start replays the choice, as the source's next start would.
  it('starts the replacement from the options the user chose, not the values the child reports', async () => {
    await store.replaceSessionOptions({
      sessionId: HOST_TEST_SESSION,
      fence: store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
      options: { model: 'test-model', effort: 'low' },
      now: HOST_TEST_NOW
    })
    adapter.readOptions = async () => ({
      models: [],
      current: { model: 'fallback-model', effort: 'high' }
    })
    const attach = vi.spyOn(host, 'attach')
    expect(await host.conversationCommand(caller, commandParams('clear'))).toMatchObject({
      ok: true
    })
    expect(attach.mock.calls[0]?.[1].options).toEqual({ model: 'test-model', effort: 'low' })
    expect(store.getRecord(HOST_TEST_SESSION)?.options).toEqual({
      model: 'test-model',
      effort: 'low'
    })
  })

  it('clears with a fresh record and effective options, retaining old history and idempotent mapping', async () => {
    const before = store.getRecord(HOST_TEST_SESSION)!
    const params = commandParams('clear')
    const result = await host.conversationCommand(caller, params)
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const nextId = result.value.replacementSessionId!
    expect(nextId).not.toBe(HOST_TEST_SESSION)
    expect(store.getRecord(nextId)).toMatchObject({
      location: before.location,
      accountHome: before.accountHome,
      options: { model: 'test-model', effort: 'high' }
    })
    expect(store.getRecord(HOST_TEST_SESSION)).not.toBeNull()
    expect(store.listVisibleSessionIds()).toEqual([nextId])
    expect((await host.history({ sessionId: nextId, direction: 'tail' })).page.items).toEqual([])
    expect(await host.conversationCommand(caller, params)).toMatchObject({
      ok: true,
      replayed: true,
      value: { replacementSessionId: nextId }
    })
    expect(acquisitions).toBe(2)
    const body = hostTestMessage('late send')
    expect(
      await host.send(caller, {
        body,
        envelope: {
          ...params.envelope,
          clientOperationId: hostTestOperationId(),
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId: HOST_TEST_SESSION,
            fields: { body }
          })
        }
      })
    ).toMatchObject({ ok: false })
    expect(adapter.dispatch).not.toHaveBeenCalled()
  })

  it('leaves the source usable when replacement creation is definitely refused', async () => {
    vi.spyOn(host, 'attach').mockResolvedValueOnce({
      ok: false,
      refusal: { code: 'structured_agent_session_unsupported', message: 'Unavailable' }
    })
    expect(await host.conversationCommand(caller, commandParams('clear'))).toMatchObject({
      ok: true,
      value: {
        state: 'completed',
        replacementSessionId: undefined,
        // The refusal's message is Orca's log text; the result words its situation.
        error: "Codex couldn't start. Start a new chat to continue.",
        failure: { kind: 'startFailed', refusal: { code: 'structured_agent_session_unsupported' } }
      }
    })
    expect(store.listVisibleSessionIds()).toEqual([HOST_TEST_SESSION])
    expect(acquisitions).toBe(1)
    expect(await host.conversationCommand(caller, commandParams('compact'))).toMatchObject({
      ok: true
    })
  })

  it('tells the user to run /clear again when the replacement could not start', async () => {
    vi.mocked(adapter.acquire).mockRejectedValueOnce(new Error('spawn codex ENOENT'))
    expect(await host.conversationCommand(caller, commandParams('clear'))).toMatchObject({
      ok: true,
      value: { state: 'completed', error: "Codex couldn't start. Run /clear again." }
    })
  })

  it('keeps the situation a refused replacement start named', async () => {
    vi.mocked(adapter.acquire).mockRejectedValueOnce(
      new AgentSessionAcquisitionRefusal('Codex is not signed in.', 'notSignedIn')
    )
    expect(await host.conversationCommand(caller, commandParams('clear'))).toMatchObject({
      ok: true,
      value: {
        state: 'completed',
        replacementSessionId: undefined,
        // The next step is the command the user ran, not a message into the old conversation.
        error: 'Codex is not signed in for the selected account. Sign in, then run /clear again.',
        failure: { kind: 'notSignedIn' }
      }
    })
    expect(store.listVisibleSessionIds()).toEqual([HOST_TEST_SESSION])
  })

  it('runs a command whose fence the client has not caught up to', async () => {
    const params = commandParams('compact')
    params.envelope.expectedRuntimeFence++
    expect(await host.conversationCommand(caller, params)).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(1))
  })
  it('reconstructs a committed replacement after the ledger settlement is lost', async () => {
    const persist = store.recordOperationOutcome.bind(store)
    vi.spyOn(store, 'recordOperationOutcome').mockImplementation(async (input) => {
      if (input.outcome.status === 'succeeded' && input.outcome.conversationCommand) {
        throw new Error('crash')
      }
      return persist(input)
    })
    const params = commandParams('clear')
    await expect(host.conversationCommand(caller, params)).rejects.toThrow('crash')
    expect(await host.conversationCommand(caller, params)).toMatchObject({
      ok: true,
      replayed: true,
      value: { state: 'completed' }
    })
    expect(acquisitions).toBe(2)
  })

  it('keeps explicitly revealed history and closed replacement tabs out of automatic restoration', async () => {
    const result = await host.conversationCommand(caller, commandParams('clear'))
    if (!result.ok) {
      throw new Error('clear failed')
    }
    expect(host.conversationReplacements()).toHaveLength(1)
    await host.setSessionTabVisibility(HOST_TEST_SESSION, true)
    expect(host.conversationReplacements()).toEqual([])
    await host.setSessionTabVisibility(HOST_TEST_SESSION, false)
    await host.setSessionTabVisibility(result.value.replacementSessionId!, false)
    expect(host.conversationReplacements()).toEqual([])
  })
})

describe('a clear that never committed', () => {
  /** The replacement's start answers with a refusal that proves nothing either way. */
  function refuseReplacementStartOnce() {
    vi.spyOn(host, 'attach').mockResolvedValueOnce({
      ok: false,
      refusal: { code: 'agent_session_operation_capacity', message: 'Too many operations.' }
    })
  }

  async function clearCommits(params = commandParams('clear')) {
    const result = await host.conversationCommand(caller, params)
    expect(result).toMatchObject({
      ok: true,
      value: { state: 'completed', replacementSessionId: expect.any(String) }
    })
    return result.ok ? result.value.replacementSessionId! : ''
  }

  it('refuses nothing afterwards: a rewind, a compaction and a send all run', async () => {
    adapter.rewindSupport = () => ({ supported: true })
    refuseReplacementStartOnce()
    await expect(host.conversationCommand(caller, commandParams('clear'))).rejects.toThrow(
      'Too many operations.'
    )
    // Past every conversation check: only the stale epoch it names stops it.
    expect(
      await host.rewind(caller, {
        envelope: envelope('agentSession.rewind', {
          itemId: 'item-1',
          expectedEpoch: 'stale-epoch'
        }),
        itemId: 'item-1',
        expectedEpoch: 'stale-epoch'
      })
    ).toMatchObject({ ok: false, refusal: { rewindReason: 'stale-epoch' } })
    expect(await host.conversationCommand(caller, commandParams('compact'))).toMatchObject({
      ok: true
    })
    expect(await host.send(caller, sendParams('still here'))).toMatchObject({ ok: true })
  })

  it('lets a clear under a new operation id commit', async () => {
    refuseReplacementStartOnce()
    await expect(host.conversationCommand(caller, commandParams('clear'))).rejects.toThrow()
    const replacement = await clearCommits()
    expect(store.listVisibleSessionIds()).toEqual([replacement])
  })

  // Its id is too old to start anything now, and it started nothing to finish.
  it('lets a clear under a new operation id commit a day after a try that started nothing', async () => {
    refuseReplacementStartOnce()
    await expect(host.conversationCommand(caller, commandParams('clear'))).rejects.toThrow()
    clock += AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS + 60_000
    const params = commandParams('clear')
    params.envelope.clientOperationId = `${clock}-${'a'.repeat(32)}`
    await clearCommits(params)
  })

  it('reruns under the same operation id and starts exactly one replacement', async () => {
    refuseReplacementStartOnce()
    const params = commandParams('clear')
    await expect(host.conversationCommand(caller, params)).rejects.toThrow()
    expect(acquisitions).toBe(1)
    await clearCommits(params)
    expect(acquisitions).toBe(2)
  })

  /** What an older build left when its clear's outcome was lost: gated every write until now. */
  async function restartOverAnOlderBuildsUnconfirmedClear() {
    const record = store.getRecord(HOST_TEST_SESSION)!
    await store.setConversationCommand(HOST_TEST_SESSION, record.lease.runtimeFence, {
      command: 'clear',
      runtimeFence: record.lease.runtimeFence,
      operationId: hostTestOperationId(),
      callerKey: caller.callerKey,
      phase: 'prepared',
      state: 'unknown',
      replacementSessionId: 'clear-from-an-older-build'
    })
    await restartHost()
  }

  it("accepts a send on a restarted host holding an older build's unconfirmed clear", async () => {
    await restartOverAnOlderBuildsUnconfirmedClear()
    expect(await host.send(caller, sendParams('after the restart'))).toMatchObject({ ok: true })
  })

  it("clears on a restarted host holding an older build's unconfirmed clear", async () => {
    await restartOverAnOlderBuildsUnconfirmedClear()
    await clearCommits()
  })

  /** A clear whose replacement started but whose commit never landed. */
  async function clearThatDiesBeforeItsCommit(params = commandParams('clear')): Promise<string> {
    const commit = store.setConversationCommand.bind(store)
    let crashed = false
    vi.spyOn(store, 'setConversationCommand').mockImplementation(async (...args) => {
      if (!crashed && args[2].phase === 'committed' && args[2].replacementSessionId) {
        crashed = true
        throw new Error('crash before the commit')
      }
      return commit(...args)
    })
    await expect(host.conversationCommand(caller, params)).rejects.toThrow(
      'crash before the commit'
    )
    const [orphan] = store
      .listRecords()
      .flatMap((record) => (record.sessionId === HOST_TEST_SESSION ? [] : [record.sessionId]))
    expect(host.collaboratorsForTests().sessions.get(orphan!)?.child).toBeTruthy()
    return orphan!
  }

  function otherRecordIds(): string[] {
    return store
      .listRecords()
      .flatMap((record) => (record.sessionId === HOST_TEST_SESSION ? [] : [record.sessionId]))
  }

  function startsFor(sessionId: string): number {
    return vi
      .mocked(adapter.acquire)
      .mock.calls.filter(([input]) => input.identity.sessionId === sessionId).length
  }

  function sendTo(sessionId: string, text: string) {
    const body = hostTestMessage(text)
    return host.send(caller, {
      body,
      envelope: {
        sessionId,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: store.getRecord(sessionId)!.lease.runtimeFence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId,
          fields: { body }
        })
      }
    })
  }

  /** The chat reads cleared onto `replacement`, which starts its agent for its first message. */
  async function expectClearedOnto(replacement: string): Promise<void> {
    expect(store.listVisibleSessionIds()).toEqual([replacement])
    expect(host.conversationReplacements().map((entry) => entry.sessionId)).toEqual([replacement])
    expect(await host.send(caller, sendParams('into the old chat'))).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'conversationCleared' } }
    })
    const started = startsFor(replacement)
    expect(await sendTo(replacement, 'first message')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(startsFor(replacement)).toBe(started + 1))
  }

  // A restart stopped the replacement the first try started, which leaves it at rest like any
  // quiet chat, so the retry switches to it.
  it('retried under the same operation id after a crash, finishes onto the replacement it started', async () => {
    const params = commandParams('clear')
    const orphan = await clearThatDiesBeforeItsCommit(params)
    await restartHost()
    await host.restoreReadableSessions(store.listVisibleSessionIds())
    const result = await host.conversationCommand(caller, params)
    expect(result).toMatchObject({
      ok: true,
      value: { phase: 'committed', state: 'completed', replacementSessionId: orphan }
    })
    expect(result.ok && result.value.error).toBeFalsy()
    expect(otherRecordIds()).toEqual([orphan])
    expect(startsFor(orphan)).toBe(1)
    await expectClearedOnto(orphan)
  })

  it('retried in the same app session once the idle sweep stopped the replacement, finishes onto it', async () => {
    const params = commandParams('clear')
    const attach = host.attach.bind(host)
    // The replacement starts, but the answer the clear gets proves nothing either way.
    vi.spyOn(host, 'attach').mockImplementationOnce(async (...args) => {
      await attach(...args)
      return {
        ok: false,
        refusal: { code: 'agent_session_operation_capacity', message: 'Too many operations.' }
      }
    })
    await expect(host.conversationCommand(caller, params)).rejects.toThrow('Too many operations.')
    const [orphan] = otherRecordIds()
    expect(store.getRecord(orphan!)?.lease.claimStatus).not.toBe('released')
    clock += STRUCTURED_AGENT_SESSION_IDLE_MS + 1
    await host.collaboratorsForTests().lifetime.idleSweep.tick()
    expect(store.getRecord(orphan!)?.lease).toMatchObject({ claimStatus: 'released' })
    const result = await host.conversationCommand(caller, params)
    expect(result).toMatchObject({
      ok: true,
      value: { phase: 'committed', state: 'completed', replacementSessionId: orphan }
    })
    expect(result.ok && result.value.error).toBeFalsy()
    expect(startsFor(orphan!)).toBe(1)
    await expectClearedOnto(orphan!)
  })

  it('retried after the replacement definitely failed to start, still reads that failure', async () => {
    vi.mocked(adapter.acquire).mockRejectedValueOnce(
      new AgentSessionAcquisitionRefusal('Codex is not signed in.', 'notSignedIn')
    )
    vi.spyOn(store, 'setConversationCommand').mockRejectedValueOnce(
      new Error('crash before the commit')
    )
    const params = commandParams('clear')
    await expect(host.conversationCommand(caller, params)).rejects.toThrow(
      'crash before the commit'
    )
    const [replacement] = otherRecordIds()
    expect(store.getRecord(replacement!)?.lease).toMatchObject({ claimStatus: 'released' })
    expect(await host.conversationCommand(caller, params)).toMatchObject({
      ok: true,
      value: {
        state: 'completed',
        replacementSessionId: undefined,
        error: 'Codex is not signed in for the selected account. Sign in, then run /clear again.',
        failure: { kind: 'notSignedIn' }
      }
    })
    expect(startsFor(replacement!)).toBe(1)
    expect(store.listVisibleSessionIds()).toEqual([HOST_TEST_SESSION])
  })

  // The client mints a fresh operation id per press; the host still finds that press's earlier try.
  it('retried under a fresh operation id while its replacement runs, finishes onto it and starts no other', async () => {
    const orphan = await clearThatDiesBeforeItsCommit()
    const result = await host.conversationCommand(caller, commandParams('clear'))
    expect(result).toMatchObject({
      ok: true,
      value: { phase: 'committed', state: 'completed', replacementSessionId: orphan }
    })
    expect(result.ok && result.value.error).toBeFalsy()
    expect(otherRecordIds()).toEqual([orphan])
    expect(startsFor(orphan)).toBe(1)
    expect(store.listVisibleSessionIds()).toEqual([orphan])
    expect(host.conversationReplacements().map((entry) => entry.sessionId)).toEqual([orphan])
    expect(await sendTo(orphan, 'first message')).toMatchObject({ ok: true })
  })

  it('retried under a fresh operation id after a restart, finishes onto the replacement it started', async () => {
    const orphan = await clearThatDiesBeforeItsCommit()
    await restartHost()
    await host.restoreReadableSessions(store.listVisibleSessionIds())
    const result = await host.conversationCommand(caller, commandParams('clear'))
    expect(result).toMatchObject({
      ok: true,
      value: { phase: 'committed', state: 'completed', replacementSessionId: orphan }
    })
    expect(otherRecordIds()).toEqual([orphan])
    expect(startsFor(orphan)).toBe(1)
    expect(store.getRecord(orphan)?.lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null
    })
    await expectClearedOnto(orphan)
  })

  it("refuses another window's /clear while this one's replacement runs, and runs it once that stops", async () => {
    const otherWindow = { callerKey: 'mobile' }
    const orphan = await clearThatDiesBeforeItsCommit()
    expect(await host.conversationCommand(otherWindow, commandParams('clear'))).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'conversationCommandInFlight' } }
    })
    expect(otherRecordIds()).toEqual([orphan])
    clock += STRUCTURED_AGENT_SESSION_IDLE_MS + 1
    await host.collaboratorsForTests().lifetime.idleSweep.tick()
    const result = await host.conversationCommand(otherWindow, commandParams('clear'))
    expect(result).toMatchObject({
      ok: true,
      value: { state: 'completed', replacementSessionId: expect.any(String) }
    })
    const replacement = result.ok ? result.value.replacementSessionId! : ''
    expect(replacement).not.toBe(orphan)
    // Nothing points at the first window's replacement, so nothing lists, opens or starts it.
    expect(store.listVisibleSessionIds()).toEqual([replacement])
    expect(host.conversationReplacements().map((entry) => entry.sessionId)).toEqual([replacement])
    expect(host.collaboratorsForTests().sessions.has(orphan)).toBe(false)
    expect(store.getRecord(orphan)?.lease).toMatchObject({ claimStatus: 'released' })
    expect(startsFor(orphan)).toBe(1)
  })

  function failNextReplacementStart() {
    vi.mocked(adapter.acquire).mockRejectedValueOnce(
      new AgentSessionAcquisitionRefusal('Codex is not signed in.', 'notSignedIn')
    )
  }

  // The other window's failure is the conversation's latest; this window's own still ended its try.
  it('starts a new replacement for a /clear after one that committed its failure, in either window', async () => {
    for (const each of [caller, { callerKey: 'mobile' }]) {
      failNextReplacementStart()
      expect(await host.conversationCommand(each, commandParams('clear'))).toMatchObject({
        ok: true,
        value: { replacementSessionId: undefined, failure: { kind: 'notSignedIn' } }
      })
    }
    const failed = otherRecordIds()
    expect(failed).toHaveLength(2)
    const replacement = await clearCommits()
    expect(failed).not.toContain(replacement)
    expect(startsFor(replacement)).toBe(1)
    expect(store.listVisibleSessionIds()).toEqual([replacement])
  })

  it('starts a new replacement after a committed failure whose ledger settlement was lost', async () => {
    failNextReplacementStart()
    const persist = store.recordOperationOutcome.bind(store)
    vi.spyOn(store, 'recordOperationOutcome').mockImplementation(async (input) => {
      if (input.outcome.status === 'succeeded' && input.outcome.conversationCommand) {
        throw new Error('crash')
      }
      return persist(input)
    })
    await expect(host.conversationCommand(caller, commandParams('clear'))).rejects.toThrow('crash')
    vi.mocked(store.recordOperationOutcome).mockRestore()
    const [failed] = otherRecordIds()
    const replacement = await clearCommits()
    expect(replacement).not.toBe(failed)
    expect(store.listVisibleSessionIds()).toEqual([replacement])
  })

  it("does not gate another window's /clear on a replacement whose stop is only unproven", async () => {
    const orphan = await clearThatDiesBeforeItsCommit()
    ownerProbe = { outcome: 'indeterminate', reason: 'test' }
    await restartHost()
    await host.restoreReadableSessions(store.listVisibleSessionIds())
    expect(store.getRecord(orphan)?.lease.claimStatus).not.toBe('released')
    const result = await host.conversationCommand({ callerKey: 'mobile' }, commandParams('clear'))
    expect(result).toMatchObject({
      ok: true,
      value: { state: 'completed', replacementSessionId: expect.any(String) }
    })
    expect(result.ok && result.value.replacementSessionId).not.toBe(orphan)
  })

  it('starts afresh when a retry under a new operation id follows a start that definitely failed', async () => {
    failNextReplacementStart()
    vi.spyOn(store, 'setConversationCommand').mockRejectedValueOnce(
      new Error('crash before the commit')
    )
    await expect(host.conversationCommand(caller, commandParams('clear'))).rejects.toThrow(
      'crash before the commit'
    )
    const [failed] = otherRecordIds()
    const result = await host.conversationCommand(caller, commandParams('clear'))
    expect(result).toMatchObject({
      ok: true,
      value: { state: 'completed', replacementSessionId: expect.any(String) }
    })
    expect(result.ok && result.value.error).toBeFalsy()
    expect(result.ok && result.value.replacementSessionId).not.toBe(failed)
  })

  it('starts afresh when a retry after a restart follows a try whose start never answered', async () => {
    let hostDies!: (error: Error) => void
    vi.mocked(adapter.acquire).mockImplementationOnce(
      () => new Promise((_, reject) => (hostDies = reject))
    )
    const dying = host.conversationCommand(caller, commandParams('clear')).catch(() => {})
    await vi.waitFor(() => expect(otherRecordIds()).toHaveLength(1))
    const [interrupted] = otherRecordIds()
    await restartHost()
    await host.restoreReadableSessions(store.listVisibleSessionIds())
    const result = await host.conversationCommand(caller, commandParams('clear'))
    expect(result).toMatchObject({
      ok: true,
      value: { state: 'completed', replacementSessionId: expect.any(String) }
    })
    expect(result.ok && result.value.error).toBeFalsy()
    expect(result.ok && result.value.replacementSessionId).not.toBe(interrupted)
    hostDies(new Error('the host that started it is gone'))
    await dying
  })
})
