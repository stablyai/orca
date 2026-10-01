import { createHash } from 'node:crypto'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'

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
    logger: createStructuredAgentSessionLogger(),
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
          // A start with no thread to resume creates one, whatever its fence.
          origin:
            input.fence > 1 && input.identity.providerHandle.kind === 'codex'
              ? ('resumed' as const)
              : ('created' as const),
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

/** Every record but the first is one a committed /clear points at: nothing is left orphaned. */
function expectEveryReplacementPointedAt(): void {
  const records = store.listRecords()
  const pointedAt = new Set(
    records.map((record) => record.conversationCommand?.replacementSessionId)
  )
  expect(
    records.filter(
      (record) =>
        record.sessionId !== HOST_TEST_SESSION &&
        !pointedAt.has(record.sessionId) &&
        !notFromAClear.has(record.sessionId)
    )
  ).toEqual([])
}
const notFromAClear = new Set<string>()

afterEach(() => {
  expectEveryReplacementPointedAt()
  notFromAClear.clear()
})

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

async function clearCommits(
  params = commandParams('clear'),
  who: { callerKey: string } = caller
): Promise<string> {
  const result = await host.conversationCommand(who, params)
  expect(result).toMatchObject({
    ok: true,
    value: {
      command: 'clear',
      phase: 'committed',
      state: 'completed',
      replacementSessionId: expect.any(String)
    }
  })
  expect(result.ok && 'error' in result.value).toBe(false)
  return result.ok ? result.value.replacementSessionId! : ''
}

/** The idle sweep stops the source's agent, leaving the chat at rest. */
async function sourceAtRest(): Promise<void> {
  clock += STRUCTURED_AGENT_SESSION_IDLE_MS + 1
  await host.collaboratorsForTests().lifetime.idleSweep.tick()
  expect(host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.child ?? null).toBeNull()
  expect(store.getRecord(HOST_TEST_SESSION)?.lease.claimStatus).toBe('released')
}

async function submissionOf(sessionId: string, clientMessageId: string) {
  return (await host.journalSnapshot(sessionId)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
}

async function errorRows(sessionId: string): Promise<string[]> {
  return (await host.journalSnapshot(sessionId)).items.flatMap((item) =>
    item.body.kind === 'status' && item.body.tone === 'error' ? [item.body.text] : []
  )
}

describe('/clear starts nothing', () => {
  it('commits the marker and an at-rest replacement founded from the source, and starts no agent', async () => {
    await store.replaceSessionOptions({
      sessionId: HOST_TEST_SESSION,
      fence: store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
      options: { model: 'test-model', effort: 'low' },
      now: HOST_TEST_NOW
    })
    const source = store.getRecord(HOST_TEST_SESSION)!
    const params = commandParams('clear')
    const replacement = await clearCommits(params)
    expect(adapter.acquire).toHaveBeenCalledTimes(1)
    expect(replacement).toMatch(/^clear-[0-9a-f]{40}$/)
    expect(store.getRecord(replacement)).toMatchObject({
      sessionId: replacement,
      location: source.location,
      provider: source.provider,
      accountHome: source.accountHome,
      options: { model: 'test-model', effort: 'low' },
      // Never started: nothing to resume, so its first start is a fresh conversation.
      providerHandleChain: [],
      lease: {
        runtimeFence: 1,
        claimStatus: 'released',
        handoffStage: null,
        ownerProcess: null,
        reservedSpawnToken: null,
        unreconciled: false,
        claimKeyId: 'key'
      }
    })
    // Written at the fence the old agent's stop released the lease at.
    expect(store.getRecord(HOST_TEST_SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      runtimeFence: source.lease.runtimeFence + 1
    })
    expect(store.getRecord(HOST_TEST_SESSION)?.conversationCommand).toEqual({
      command: 'clear',
      phase: 'committed',
      state: 'completed',
      runtimeFence: source.lease.runtimeFence + 1,
      operationId: params.envelope.clientOperationId,
      callerKey: caller.callerKey,
      replacementSessionId: replacement
    })
    expect(store.listVisibleSessionIds()).toEqual([replacement])
    expect(host.conversationReplacements().map((entry) => entry.sessionId)).toEqual([replacement])
    expect(host.collaboratorsForTests().sessions.get(replacement)?.child ?? null).toBeNull()
    expect((await host.history({ sessionId: replacement, direction: 'tail' })).page.items).toEqual(
      []
    )
    // The old conversation stays readable and takes no more messages.
    expect(await host.send(caller, sendParams('into the old chat'))).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'conversationCleared' } }
    })
    expect(adapter.dispatch).not.toHaveBeenCalled()
  })

  it('copies the launch arguments the source was pinned to', async () => {
    const pinned = 'session-pinned'
    expect(
      await host.attach(
        caller,
        hostTestAttachParams(null, {
          envelope: {
            sessionId: pinned,
            clientOperationId: hostTestOperationId(),
            expectedRuntimeFence: null,
            payloadFingerprint: ''
          },
          launchArgs: ['--flag']
        })
      )
    ).toMatchObject({ ok: true })
    const clear = { ...commandParams('clear') }
    clear.envelope = {
      sessionId: pinned,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(pinned)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.conversationCommand',
        sessionId: pinned,
        fields: { command: 'clear' }
      })
    }
    notFromAClear.add(pinned)
    const replacement = await clearCommits(clear)
    expect(store.getRecord(replacement)?.launchArgs).toEqual(['--flag'])
  })

  it("does not start an at-rest source's agent", async () => {
    await sourceAtRest()
    const starts = vi.mocked(adapter.acquire).mock.calls.length
    const replacement = await clearCommits()
    expect(adapter.acquire).toHaveBeenCalledTimes(starts)
    expect(startsFor(HOST_TEST_SESSION)).toBe(1)
    expect(startsFor(replacement)).toBe(0)
  })

  it("stops a running source's agent before it writes the marker", async () => {
    const commit = store.commitConversationClear
    let atCommit: { child: unknown; claim: string | undefined } | undefined
    vi.spyOn(store, 'commitConversationClear').mockImplementationOnce(async (clear) => {
      atCommit = {
        child: host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.child ?? null,
        claim: store.getRecord(HOST_TEST_SESSION)?.lease.claimStatus
      }
      return commit(clear)
    })
    await clearCommits()
    expect(atCommit).toEqual({ child: null, claim: 'released' })
  })

  it('founds one record per /clear through a chain of clears, starting neither', async () => {
    const first = await clearCommits()
    const second = await host.conversationCommand(caller, {
      command: 'clear',
      envelope: {
        sessionId: first,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: store.getRecord(first)!.lease.runtimeFence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.conversationCommand',
          sessionId: first,
          fields: { command: 'clear' }
        })
      }
    })
    expect(second).toMatchObject({ ok: true, value: { replacementSessionId: expect.any(String) } })
    const last = second.ok ? second.value.replacementSessionId! : ''
    expect(last).not.toBe(first)
    expect(store.listRecords().map((record) => record.sessionId)).toEqual(
      expect.arrayContaining([HOST_TEST_SESSION, first, last])
    )
    expect(store.listRecords()).toHaveLength(3)
    expect(startsFor(first) + startsFor(last)).toBe(0)
    expect(store.listVisibleSessionIds()).toEqual([last])
    expect(host.conversationReplacements()).toEqual([
      expect.objectContaining({ sourceSessionId: HOST_TEST_SESSION, sessionId: last }),
      expect.objectContaining({ sourceSessionId: first, sessionId: last })
    ])
  })

  it('writes nothing when its one write fails, leaving the source usable', async () => {
    adapter.rewindSupport = () => ({ supported: true })
    vi.spyOn(store, 'commitConversationClear').mockRejectedValueOnce(new Error('disk full'))
    await expect(host.conversationCommand(caller, commandParams('clear'))).rejects.toThrow(
      'disk full'
    )
    expect(store.listRecords().map((record) => record.sessionId)).toEqual([HOST_TEST_SESSION])
    expect(store.getRecord(HOST_TEST_SESSION)?.conversationCommand).toBeUndefined()
    expect(store.listVisibleSessionIds()).toEqual([HOST_TEST_SESSION])
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

  it('reruns under the same operation id after its write failed, and commits once', async () => {
    vi.spyOn(store, 'commitConversationClear').mockRejectedValueOnce(new Error('disk full'))
    const params = commandParams('clear')
    await expect(host.conversationCommand(caller, params)).rejects.toThrow('disk full')
    const replacement = await clearCommits(params)
    expect(store.listRecords()).toHaveLength(2)
    expect(store.listVisibleSessionIds()).toEqual([replacement])
  })

  it('replays a same-id resend with the one replacement it committed', async () => {
    const params = commandParams('clear')
    const replacement = await clearCommits(params)
    expect(await host.conversationCommand(caller, params)).toMatchObject({
      ok: true,
      replayed: true,
      value: { replacementSessionId: replacement }
    })
    expect(store.listRecords()).toHaveLength(2)
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
    const [replacement] = store
      .listRecords()
      .flatMap((record) => (record.sessionId === HOST_TEST_SESSION ? [] : [record.sessionId]))
    expect(await host.conversationCommand(caller, params)).toMatchObject({
      ok: true,
      replayed: true,
      value: { state: 'completed', replacementSessionId: replacement }
    })
    expect(store.listRecords()).toHaveLength(2)
    expect(acquisitions).toBe(1)
  })

  it("answers another window's /clear after the commit with the cleared refusal, never an in-flight one", async () => {
    await clearCommits()
    expect(
      await host.conversationCommand({ callerKey: 'mobile' }, commandParams('clear'))
    ).toMatchObject({ ok: false, refusal: { details: { reason: 'conversationCleared' } } })
    expect(store.listRecords()).toHaveLength(2)
  })

  it('keeps explicitly revealed history and closed replacement tabs out of automatic restoration', async () => {
    const replacement = await clearCommits()
    expect(host.conversationReplacements()).toHaveLength(1)
    await host.setSessionTabVisibility(HOST_TEST_SESSION, true)
    expect(host.conversationReplacements()).toEqual([])
    await host.setSessionTabVisibility(HOST_TEST_SESSION, false)
    await host.setSessionTabVisibility(replacement, false)
    expect(host.conversationReplacements()).toEqual([])
  })

  it('runs a command whose fence the client has not caught up to', async () => {
    const params = commandParams('compact')
    params.envelope.expectedRuntimeFence++
    expect(await host.conversationCommand(caller, params)).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(1))
  })
})

describe("the replacement's first send", () => {
  it('starts a fresh conversation and delivers the message', async () => {
    const replacement = await clearCommits()
    const sent = await sendTo(replacement, 'first message')
    expect(sent).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(adapter.dispatch).toHaveBeenCalledTimes(1))
    expect(startsFor(replacement)).toBe(1)
    const [start] = vi
      .mocked(adapter.acquire)
      .mock.calls.flatMap(([input]) => (input.identity.sessionId === replacement ? [input] : []))
    // No provider conversation to resume: the source's thread is not carried over.
    expect(start?.identity.providerHandle).toEqual({
      kind: 'opaque',
      agent: 'codex',
      value: 'pending'
    })
    expect(start?.fence).toBe(2)
    expect(store.getRecord(replacement)?.lease).toMatchObject({ claimStatus: 'live' })
  })

  it('starts with the options the user chose, and adopts what the started child reports', async () => {
    await store.replaceSessionOptions({
      sessionId: HOST_TEST_SESSION,
      fence: store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
      options: { model: 'test-model', effort: 'low' },
      now: HOST_TEST_NOW
    })
    adapter.readOptions = async () => ({
      models: [],
      current: { model: 'test-model', effort: 'low', fastMode: false }
    })
    const replacement = await clearCommits()
    expect(await sendTo(replacement, 'first message')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(startsFor(replacement)).toBe(1))
    const [start] = vi
      .mocked(adapter.acquire)
      .mock.calls.flatMap(([input]) => (input.identity.sessionId === replacement ? [input] : []))
    expect(start?.options).toEqual({ model: 'test-model', effort: 'low' })
    await vi.waitFor(() =>
      expect(store.getRecord(replacement)?.options).toEqual({
        model: 'test-model',
        effort: 'low',
        fastMode: 'false'
      })
    )
  })

  it('applies an option picked on the replacement before its first send', async () => {
    const replacement = await clearCommits()
    const picked = await host.setOption(caller, {
      envelope: {
        sessionId: replacement,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: store.getRecord(replacement)!.lease.runtimeFence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.setOption',
          sessionId: replacement,
          fields: { key: 'model', value: 'picked-model' }
        })
      },
      key: 'model',
      value: 'picked-model'
    })
    expect(picked).toMatchObject({ ok: true })
    expect(startsFor(replacement)).toBe(0)
    expect(await sendTo(replacement, 'first message')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(startsFor(replacement)).toBe(1))
    const [start] = vi
      .mocked(adapter.acquire)
      .mock.calls.flatMap(([input]) => (input.identity.sessionId === replacement ? [input] : []))
    expect(start?.options).toMatchObject({ model: 'picked-model' })
  })

  it.each([
    {
      name: 'not signed in',
      error: () => new AgentSessionAcquisitionRefusal('Codex is not signed in.', 'notSignedIn'),
      words:
        'Codex is not signed in for the selected account. Sign in, then send your message again.',
      kind: 'notSignedIn'
    },
    {
      name: 'a generic refusal',
      error: () => new Error('spawn codex ENOENT'),
      words: "Codex couldn't start.",
      kind: 'startFailed'
    }
  ])(
    'fails on the message when the start fails ($name): one row, the message kept as not sent, and Retry starts it',
    async ({ error, words, kind }) => {
      const replacement = await clearCommits()
      vi.mocked(adapter.acquire).mockRejectedValueOnce(error())
      const sent = await sendTo(replacement, 'first message')
      expect(sent).toMatchObject({ ok: true })
      const clientMessageId = sent.ok ? sent.value.clientMessageId : ''
      await vi.waitFor(async () =>
        expect(await submissionOf(replacement, clientMessageId)).toMatchObject({
          dispatchState: 'rejected',
          rejection: { kind }
        })
      )
      const rows = await errorRows(replacement)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toContain(words)
      expect(rows.join(' ')).not.toContain('/clear')
      expect((await submissionOf(replacement, clientMessageId))?.reason).not.toContain('/clear')
      expect(adapter.dispatch).not.toHaveBeenCalled()

      // Retry resends the same words, which starts the agent and delivers them.
      expect(await sendTo(replacement, 'first message')).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(adapter.dispatch).toHaveBeenCalledTimes(1))
      expect(startsFor(replacement)).toBe(2)
    }
  )

  it('starts after a restart between the /clear and the first send', async () => {
    const replacement = await clearCommits()
    await restartHost()
    await host.restoreReadableSessions(store.listVisibleSessionIds())
    expect(store.getRecord(replacement)?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      runtimeFence: 1
    })
    expect(host.conversationReplacements().map((entry) => entry.sessionId)).toEqual([replacement])
    expect(await sendTo(replacement, 'first message')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(adapter.dispatch).toHaveBeenCalledTimes(1))
    expect(startsFor(replacement)).toBe(1)
  })
})

describe('what an older build left', () => {
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

  // The build before this one started the replacement before committing, so a crash between the
  // two left a started record nothing points at, and its start in the ledger.
  it('founds a fresh replacement beside the orphan an older build started for the same operation id', async () => {
    const params = commandParams('clear')
    const { clientOperationId } = params.envelope
    // The older build derived both ids from the operation, then crashed between start and commit.
    const digest = createHash('sha256')
      .update(JSON.stringify([HOST_TEST_SESSION, caller.callerKey, clientOperationId]))
      .digest('hex')
    const orphanStart = hostTestAttachParams(null, {
      envelope: {
        sessionId: `clear-${digest.slice(0, 40)}`,
        clientOperationId: `${HOST_TEST_NOW}-${digest.slice(0, 32)}`,
        expectedRuntimeFence: null,
        payloadFingerprint: ''
      }
    })
    const orphan = orphanStart.envelope.sessionId
    notFromAClear.add(orphan)
    expect(
      await store.admitMutationOperation({
        callerKey: caller.callerKey,
        envelope: params.envelope,
        hostFingerprint: params.envelope.payloadFingerprint,
        now: clock
      })
    ).toMatchObject({ admission: { decision: 'admit' } })
    expect(await host.attach(caller, orphanStart)).toMatchObject({ ok: true })
    await restartHost()
    await host.restoreReadableSessions(store.listVisibleSessionIds())

    const replacement = await clearCommits(params)
    expect(replacement).not.toBe(orphan)
    expect(store.listVisibleSessionIds()).toEqual([replacement])
    expect(host.conversationReplacements().map((entry) => entry.sessionId)).toEqual([replacement])
    expect(host.collaboratorsForTests().sessions.has(orphan)).toBe(false)
    expect(startsFor(orphan)).toBe(1)
    expect(startsFor(replacement)).toBe(0)
  })
})

// Every press carries its own operation id, so a /clear pressed after one committed is a new call.
describe('a /clear pressed again after it committed', () => {
  function replacementsOtherThanTheSource(): string[] {
    return store
      .listRecords()
      .flatMap((record) => (record.sessionId === HOST_TEST_SESSION ? [] : [record.sessionId]))
  }

  function startsForSource(): number {
    return vi
      .mocked(adapter.acquire)
      .mock.calls.filter(([input]) => input.identity.sessionId === HOST_TEST_SESSION).length
  }

  async function expectAnsweredWithTheCommittedClear(replacement: string): Promise<void> {
    const starts = startsForSource()
    const result = await host.conversationCommand(caller, commandParams('clear'))
    expect(result).toMatchObject({
      ok: true,
      value: { phase: 'committed', state: 'completed', replacementSessionId: replacement }
    })
    expect(result.ok && result.value.error).toBeFalsy()
    expect(replacementsOtherThanTheSource()).toEqual([replacement])
    // The cleared conversation's agent is not started to answer it.
    expect(startsForSource()).toBe(starts)
    expect(store.listVisibleSessionIds()).toEqual([replacement])
    expect(host.conversationReplacements().map((entry) => entry.sessionId)).toEqual([replacement])
  }

  it('answers a double press with the clear the first press committed', async () => {
    const first = await host.conversationCommand(caller, commandParams('clear'))
    const replacement = first.ok ? first.value.replacementSessionId! : ''
    expect(replacement).toBeTruthy()
    // What the RPC handler does once the first answer is out.
    await host.close(HOST_TEST_SESSION, 'user-close')
    await expectAnsweredWithTheCommittedClear(replacement)
  })

  it('answers a retyped /clear whose committed answer was lost with that clear', async () => {
    const persist = store.recordOperationOutcome.bind(store)
    let lost = false
    vi.spyOn(store, 'recordOperationOutcome').mockImplementation(async (input) => {
      if (!lost && input.outcome.status === 'succeeded' && input.outcome.conversationCommand) {
        lost = true
        throw new Error('connection lost')
      }
      return persist(input)
    })
    await expect(host.conversationCommand(caller, commandParams('clear'))).rejects.toThrow(
      'connection lost'
    )
    const [replacement] = replacementsOtherThanTheSource()
    await expectAnsweredWithTheCommittedClear(replacement!)
  })

  it('refuses a second /clear pressed under a new id while the first is still running', async () => {
    const [first, second] = await Promise.all([
      host.conversationCommand(caller, commandParams('clear')),
      host.conversationCommand(caller, commandParams('clear'))
    ])
    expect(first).toMatchObject({ ok: true })
    expect(second).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'conversationCommandInFlight' } }
    })
    expect(replacementsOtherThanTheSource()).toHaveLength(1)
  })

  it('still tells another window the conversation was cleared', async () => {
    expect((await host.conversationCommand(caller, commandParams('clear'))).ok).toBe(true)
    expect(
      await host.conversationCommand({ callerKey: 'mobile' }, commandParams('clear'))
    ).toMatchObject({ ok: false, refusal: { details: { reason: 'conversationCleared' } } })
    expect(replacementsOtherThanTheSource()).toHaveLength(1)
  })

  // Opened again from history on purpose, so that tab stays on the cleared conversation.
  it('still tells a cleared conversation opened from history that it was cleared', async () => {
    expect((await host.conversationCommand(caller, commandParams('clear'))).ok).toBe(true)
    await host.setSessionTabVisibility(HOST_TEST_SESSION, true)
    expect(await host.conversationCommand(caller, commandParams('clear'))).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'conversationCleared' } }
    })
    expect(replacementsOtherThanTheSource()).toHaveLength(1)
  })
})
