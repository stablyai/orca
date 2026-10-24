import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionStatusEvent,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import {
  adapter,
  attach,
  attachParams,
  CALLER,
  ensureParams,
  envelope,
  hostTestState,
  replaceHostTestState,
  seedApproval
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let releaseAcquisition: Mock<NonNullable<StructuredAgentSessionAdapter['releaseAcquisition']>>
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let cancelTurn: Mock<StructuredAgentSessionAdapter['cancelTurn']>
let answerPrompt: Mock<StructuredAgentSessionAdapter['answerPrompt']>
let setOption: Mock<StructuredAgentSessionAdapter['setOption']>

beforeEach(() => {
  ;({
    root,
    store,
    host,
    acquire,
    releaseAcquisition,
    dispatch,
    cancelTurn,
    answerPrompt,
    setOption
  } = hostTestState())
})

describe('attach', () => {
  it('founds a client-location floating chat with the host folder and keeps it on replay', async () => {
    const resolveWorkspacePath = vi.fn(async () => '/host/original-folder')
    host.deps.resolveWorkspacePath = resolveWorkspacePath
    const params = attachParams({
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: FLOATING_TERMINAL_WORKTREE_ID,
        workspaceKind: 'folder'
      }
    })

    expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
    expect(store.getRecord(SESSION)?.launchDirectory).toBe('/host/original-folder')
    resolveWorkspacePath.mockResolvedValue('/host/changed-folder')

    expect(await host.attach(CALLER, params)).toMatchObject({ ok: true, replayed: true })
    expect(store.getRecord(SESSION)?.launchDirectory).toBe('/host/original-folder')
    expect(resolveWorkspacePath).toHaveBeenCalledTimes(1)
  })

  it('reserves the lease, spawns through the adapter, and opens the journal', async () => {
    const result = await host.attach(CALLER, attachParams())
    expect(result).toMatchObject({ ok: true, replayed: false })
    const record = store.getRecord(SESSION)
    expect(record?.lease.ownerProcess?.pid).toBe(4242)
    expect(record?.lease.handoffStage).toBeNull()
  })

  it('refuses a payload the client fingerprinted wrong', async () => {
    const params = attachParams()
    const result = await host.attach(CALLER, {
      ...params,
      envelope: { ...params.envelope, payloadFingerprint: 'a'.repeat(64) }
    })
    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_conflict' }
    })
  })

  it('refuses a provider handle that belongs to a different provider', async () => {
    const params = attachParams({
      providerHandle: { kind: 'claude', sessionId: 'claude-session', leafUuid: null }
    })

    expect(await host.attach(CALLER, params)).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })
    expect(store.getRecord(SESSION)).toBeNull()
  })

  it('refuses a second create against a live session', async () => {
    await attach()
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: false })
  })

  it('replays a retried attach instead of reserving a second owner', async () => {
    const params = attachParams()
    await host.attach(CALLER, params)
    const retry = await host.attach(CALLER, params)
    expect(retry).toMatchObject({ ok: true, replayed: true })
  })

  it('retires a failed proved acquisition before admitting a fresh operation', async () => {
    const acquire = vi
      .fn<StructuredAgentSessionAdapter['acquire']>()
      .mockImplementationOnce(async ({ fence, spawnToken }) => ({
        process: {
          hostId: 'local',
          pid: 4242,
          processStartTimeMs: 1_700_000_000_000,
          spawnToken
        },
        link: {
          linkId: 'stale-link',
          handle: codexProviderHandle(THREAD),
          origin: 'created',
          mintedAtFence: fence + 1,
          observedAt: NOW
        },
        acquisitionGeneration: 'generation-stale'
      }))
      .mockImplementation(async ({ fence, spawnToken }) => ({
        process: {
          hostId: 'local',
          pid: 4242,
          processStartTimeMs: 1_700_000_000_000,
          spawnToken
        },
        link: {
          linkId: `link-${fence}`,
          handle: codexProviderHandle(THREAD),
          origin: 'created',
          mintedAtFence: fence,
          observedAt: NOW
        },
        acquisitionGeneration: `generation-${fence}`
      }))
    host = new StructuredAgentSessionHost({
      agents: NO_STRUCTURED_AGENTS,
      logger: createStructuredAgentSessionLogger(),
      store,
      adapter: { ...adapter(), acquire },
      journalDatabase: openTestJournalHostDatabase(root),
      claimKeyId: 'key-1',
      mintSpawnToken: () => 'spawn-a',
      now: () => NOW
    })
    const params = attachParams()

    // Host storage failure must not blame the provider.
    const refused = {
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        details: { ownerVerdict: 'exited' },
        message: "Codex couldn't restart. Send your message to try again.",
        ownerVerdict: 'exited'
      }
    }
    expect(await host.attach(CALLER, params)).toEqual(refused)
    expect(await host.attach(CALLER, params)).toEqual(refused)
    const releasedFence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    expect(await host.attach(CALLER, ensureParams(releasedFence))).toMatchObject({ ok: true })
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
    expect(releaseAcquisition).toHaveBeenCalledWith({ sessionId: SESSION })
  })

  it('reaps an acquisition when process identity commit fails', async () => {
    vi.spyOn(store, 'commitProcessIdentity').mockRejectedValueOnce(new Error('commit failed'))

    await expect(host.attach(CALLER, attachParams())).resolves.toMatchObject({
      ok: false,
      refusal: {
        message: "Codex couldn't restart. Send your message to try again.",
        ownerVerdict: 'exited'
      }
    })

    expect(releaseAcquisition).toHaveBeenCalledWith({ sessionId: SESSION })
  })

  it('drains writes captured by the old journal before acquiring its replacement', async () => {
    const record = await attach()
    const events = acquire.mock.calls[0]?.[0].events
    const oldJournal = (
      host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> }
    ).sessions.get(SESSION)!.journal
    const appendGate = Promise.withResolvers<void>()
    const originalAppend = oldJournal.appendItem.bind(oldJournal)
    const append = vi.spyOn(oldJournal, 'appendItem').mockImplementationOnce(async (...args) => {
      await appendGate.promise
      return originalAppend(...args)
    })
    events?.appendItem(
      { provider: 'orca', clientMessageId: 'old-journal-write' },
      { kind: 'status', text: 'old journal write' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await vi.waitFor(() => expect(append).toHaveBeenCalledOnce())
    const released = await store.evictProvenDeadOwner({
      sessionId: SESSION,
      expectedFence: record?.lease.runtimeFence ?? 1,
      probe: { outcome: 'pid-absent' },
      now: NOW
    })

    const replacement = host.attach(CALLER, ensureParams(released.lease.runtimeFence))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(acquire).toHaveBeenCalledTimes(1)

    appendGate.resolve()
    await expect(replacement).resolves.toMatchObject({ ok: true })
    expect(acquire).toHaveBeenCalledTimes(2)
  })
})

describe('cancel', () => {
  /** A named Stop needs an existing turn; unknown turns are late no-ops. */
  async function runningTurn(): Promise<void> {
    await attach()
    acquire.mock.calls
      .at(-1)![0]
      .events!.appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 900 },
        { kind: 'turn', turnId: 'turn-1', state: 'running' },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    await host.flushStreamedEvents(SESSION)
  }

  it('records the request acknowledgement as a status item keyed by the operation id', async () => {
    await runningTurn()
    const result = await host.cancel(CALLER, {
      envelope: envelope('agentSession.cancel', { turnId: 'turn-1' }),
      turnId: 'turn-1'
    })
    expect(result).toMatchObject({ ok: true, value: { cancelled: true } })
    const page = await host.history({ sessionId: SESSION, direction: 'tail' })
    const note = page.ok ? page.page.items.find((item) => item.body.kind === 'status') : undefined
    expect(note?.body).toMatchObject({
      kind: 'status',
      text: 'Cancellation requested.'
    })
    expect(JSON.stringify(note?.body)).not.toContain('turn-1')
  })

  it('ends the child when the turn runs on after an unanswered interrupt', async () => {
    await runningTurn()
    cancelTurn.mockRejectedValueOnce(new Error('no answer'))
    const result = await host.cancel(CALLER, {
      envelope: envelope('agentSession.cancel', { turnId: 'turn-1' }),
      turnId: 'turn-1'
    })
    expect(result).toMatchObject({ ok: true, value: { cancelled: true } })
  })

  it('never interrupts twice on a replay', async () => {
    await runningTurn()
    const params = {
      envelope: envelope('agentSession.cancel', { turnId: 'turn-1' }),
      turnId: 'turn-1'
    }
    await host.cancel(CALLER, params)
    expect(await host.cancel(CALLER, params)).toMatchObject({
      ok: true,
      replayed: true,
      value: { cancelled: false }
    })
    expect(cancelTurn).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a missing prompt item', { itemId: 'missing-item', expectedRevision: 1 }],
    ['a stale prompt revision', { itemId: 'seeded', expectedRevision: 2 }]
  ])('refuses %s before interrupting the provider', async (_case, requestedPrompt) => {
    await attach()
    const prompt = await seedApproval()
    const strictPrompt = {
      ...requestedPrompt,
      ...(requestedPrompt.itemId === 'seeded' ? { itemId: prompt.itemId } : {})
    }
    const fields = { turnId: 'turn-1', prompt: strictPrompt }

    expect(
      await host.cancel(CALLER, {
        envelope: envelope('agentSession.cancel', fields),
        ...fields
      })
    ).toMatchObject({ ok: false })
    expect(cancelTurn).not.toHaveBeenCalled()
  })

  it('refuses cancellation after an answer has already resolved the prompt', async () => {
    await attach()
    const prompt = await seedApproval()
    const answer = {
      itemId: prompt.itemId,
      expectedRevision: prompt.revision,
      optionId: 'allow'
    }
    await host.respondToPrompt(CALLER, {
      envelope: envelope('agentSession.respondTo:approval', answer),
      kind: 'approval',
      ...answer
    })
    const fields = {
      turnId: 'turn-1',
      prompt: { itemId: prompt.itemId, expectedRevision: prompt.revision }
    }

    expect(
      await host.cancel(CALLER, {
        envelope: envelope('agentSession.cancel', fields),
        ...fields
      })
    ).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_item_revision_stale' }
    })
    expect(cancelTurn).not.toHaveBeenCalled()
  })

  it('answers a strict prompt interruption that throws once saved from its receipt, the same on a retry, and never retries it', async () => {
    await attach()
    const prompt = await seedApproval()
    cancelTurn.mockRejectedValueOnce(new Error('interrupt receipt lost'))
    const fields = {
      turnId: 'turn-1',
      prompt: { itemId: prompt.itemId, expectedRevision: prompt.revision }
    }
    const params = {
      envelope: envelope('agentSession.cancel', fields),
      ...fields
    }

    // The durable receipt survives interrupt failure; retry must not repeat the provider effect.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const answered = await host.cancel(CALLER, params)
    expect(answered).toMatchObject({ ok: true })
    expect(await host.cancel(CALLER, params)).toEqual({ ...answered, replayed: true })
    expect(cancelTurn).toHaveBeenCalledTimes(1)
    const page = await host.history({ sessionId: SESSION, direction: 'tail' })
    const bodies = page.ok ? page.page.items.map((item) => item.body) : []
    expect(bodies).toEqual([
      expect.objectContaining({ resolution: expect.objectContaining({ state: 'pending' }) }),
      expect.objectContaining({ kind: 'status', text: 'Cancellation was not confirmed.' })
    ])
  })
})

describe('respondToPrompt', () => {
  it('commits the answer before the provider callback', async () => {
    await attach()
    const prompt = await seedApproval()
    const fields = { itemId: prompt.itemId, expectedRevision: prompt.revision, optionId: 'allow' }
    const result = await host.respondToPrompt(CALLER, {
      envelope: envelope('agentSession.respondTo:approval', fields),
      kind: 'approval',
      ...fields
    })
    expect(result).toMatchObject({
      ok: true,
      value: { resolution: { state: 'resolved', selectedOptionId: 'allow' } }
    })
    expect(answerPrompt).toHaveBeenCalledTimes(1)
  })

  it("keeps a subagent's approval the subagent's once the user answers it", async () => {
    // Answer revisions omit producer identity and must retain the asker.
    await attach()
    const child = { agentId: 'thread-child', producerKind: 'agent' as const }
    const identity = {
      provider: 'codex' as const,
      threadId: 'thread-child',
      turnId: 'c',
      ordinal: 1
    }
    acquire.mock.calls.at(-1)?.[0].events?.appendItem(
      identity,
      {
        kind: 'approval',
        title: 'Run ls?',
        detail: null,
        options: [{ id: 'allow', label: 'Allow' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      },
      { ...child, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await host.flushStreamedEvents(SESSION)
    const itemId = agentJournalItemKey(identity)
    const fields = { itemId, expectedRevision: 1, optionId: 'allow' }

    await host.respondToPrompt(CALLER, {
      envelope: envelope('agentSession.respondTo:approval', fields),
      kind: 'approval',
      ...fields
    })

    const page = await host.history({ sessionId: SESSION, direction: 'tail' })
    const answered = page.ok ? page.page.items.find((item) => item.itemId === itemId) : null
    expect(answered).toMatchObject({
      revision: 2,
      body: { resolution: { state: 'resolved' } },
      ...child
    })
  })

  it('tells a second answer with the same choice that it holds, and asks the provider once', async () => {
    await attach()
    const prompt = await seedApproval()
    const fields = { itemId: prompt.itemId, expectedRevision: prompt.revision, optionId: 'allow' }
    const first = await host.respondToPrompt(CALLER, {
      envelope: envelope('agentSession.respondTo:approval', fields),
      kind: 'approval',
      ...fields
    })
    // A different operation repeats the choice, as another device or lost-reply retry would.
    const second = await host.respondToPrompt(
      { callerKey: 'client-2' },
      {
        envelope: envelope('agentSession.respondTo:approval', fields),
        kind: 'approval',
        ...fields
      }
    )
    expect(first.ok).toBe(true)
    expect(second).toEqual({ ...first, replayed: false })
    expect(second).toMatchObject({
      ok: true,
      value: { resolution: { selectedOptionId: 'allow', resolvedBy: 'client-1' } }
    })
    expect(answerPrompt).toHaveBeenCalledTimes(1)
  })

  it('refuses an option the prompt does not offer', async () => {
    await attach()
    const prompt = await seedApproval()
    const fields = { itemId: prompt.itemId, expectedRevision: prompt.revision, optionId: 'deny' }
    expect(
      await host.respondToPrompt(CALLER, {
        envelope: envelope('agentSession.respondTo:approval', fields),
        kind: 'approval',
        ...fields
      })
    ).toMatchObject({ ok: false, refusal: { code: 'agent_session_operation_invalid' } })
    expect(answerPrompt).not.toHaveBeenCalled()
  })

  it("does not turn a refused answer into another client's successful answer", async () => {
    await attach()
    const prompt = await seedApproval()
    const rejectedFields = {
      itemId: prompt.itemId,
      expectedRevision: prompt.revision,
      optionId: 'deny'
    }
    const rejected = {
      envelope: envelope('agentSession.respondTo:approval', rejectedFields),
      kind: 'approval' as const,
      ...rejectedFields
    }
    await host.respondToPrompt(CALLER, rejected)

    const acceptedFields = { ...rejectedFields, optionId: 'allow' }
    await host.respondToPrompt(
      { callerKey: 'client-2' },
      {
        envelope: envelope('agentSession.respondTo:approval', acceptedFields),
        kind: 'approval',
        ...acceptedFields
      }
    )

    // Refusals record nothing; retry evaluates the now-changed prompt.
    expect(await host.respondToPrompt(CALLER, rejected)).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_item_revision_stale' }
    })
    expect(answerPrompt).toHaveBeenCalledOnce()
  })

  it('keeps the answer and reports it undelivered when the provider callback throws', async () => {
    await attach()
    const prompt = await seedApproval()
    answerPrompt.mockImplementationOnce(async ({ commit }) => {
      await commit()
      throw new Error('pipe closed')
    })
    const fields = { itemId: prompt.itemId, expectedRevision: prompt.revision, optionId: 'allow' }
    const result = await host.respondToPrompt(CALLER, {
      envelope: envelope('agentSession.respondTo:approval', fields),
      kind: 'approval',
      ...fields
    })
    expect(result.ok).toBe(true)
    const page = await host.history({ sessionId: SESSION, direction: 'tail' })
    const statusId = agentJournalItemKey({
      provider: 'orca',
      clientMessageId: `${prompt.itemId}#delivery`
    })
    expect(page.ok && page.page.items.some((entry) => entry.itemId === statusId)).toBe(true)
  })
})

describe('setOption', () => {
  it('saves a next-message pick without changing the provider', async () => {
    await attach()
    setOption.mockResolvedValueOnce({ model: 'gpt-5', effort: 'high' })
    const fields = { key: 'model', value: 'gpt-5' }
    const params = {
      envelope: envelope('agentSession.setOption', fields),
      ...fields
    }
    const result = await host.setOption(CALLER, params)
    expect(result).toMatchObject({
      ok: true,
      value: { ...fields, options: { model: 'gpt-5' } }
    })
    expect(await host.setOption(CALLER, params)).toMatchObject({
      ok: true,
      replayed: true,
      value: { ...fields, options: { model: 'gpt-5' } }
    })
    expect(setOption).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION)?.options).toEqual({ model: 'gpt-5' })
    const page = await host.history({ sessionId: SESSION, direction: 'tail' })
    expect(page.ok && page.page.items).toHaveLength(0)
  })

  it('replays the accepted pick without contacting the provider', async () => {
    await attach()
    setOption.mockRejectedValueOnce(new Error('reply lost'))
    const fields = { key: 'model', value: 'gpt-5' }
    const params = {
      envelope: envelope('agentSession.setOption', fields),
      ...fields
    }

    expect(await host.setOption(CALLER, params)).toMatchObject({ ok: true })
    expect(await host.setOption(CALLER, params)).toMatchObject({
      ok: true,
      replayed: true
    })
    expect(setOption).not.toHaveBeenCalled()
  })
})

describe('restart', () => {
  /** Reopen real directories with a new host/store and unreconciled leases. */
  async function reboot(
    probeOwner: (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>,
    adapterOverrides: Partial<StructuredAgentSessionAdapter> = {},
    stopOwnerProcess?: StructuredAgentSessionHostDeps['stopOwnerProcess']
  ) {
    store = await openTestAgentSessionRecordStore(root)
    host = new StructuredAgentSessionHost({
      agents: NO_STRUCTURED_AGENTS,
      logger: createStructuredAgentSessionLogger(),
      store,
      adapter: { ...adapter(), ...adapterOverrides },
      journalDatabase: openTestJournalHostDatabase(root),
      claimKeyId: 'key-1',
      mintSpawnToken: () => 'spawn-b',
      probeOwner,
      ...(stopOwnerProcess ? { stopOwnerProcess } : {}),
      now: () => NOW
    })
    replaceHostTestState({ store, host })
  }

  /** Recover the live fence from a dead-generation refusal. */
  async function staleFenceFrom(held: number): Promise<number> {
    const refused = await host.attach(CALLER, ensureParams(held))
    if (refused.ok) {
      throw new Error('a fence from the previous host generation was accepted')
    }
    expect(refused.refusal.code).toBe('agent_session_checkpoint_stale')
    const current = refused.refusal.currentFence
    expect(current).toBeGreaterThan(held)
    return current ?? 0
  }

  it('adjudicates the leases it loaded before deciding who may write', async () => {
    const before = await attach()
    const held = before?.lease.runtimeFence ?? 0
    await reboot(async () => ({ outcome: 'pid-absent' }))

    const reattached = await host.attach(CALLER, ensureParams(await staleFenceFrom(held)))
    expect(reattached).toMatchObject({ ok: true })
    expect(store.getRecord(SESSION)?.lease.unreconciled).toBe(false)
    expect(store.getRecord(SESSION)?.lease.ownerProcess?.pid).toBe(4242)
  })

  it('restores durable journals for read-only history without acquiring a provider', async () => {
    await attach()
    const body = hostTestMessage('persisted conversation')
    await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
    await reboot(async () => ({ outcome: 'indeterminate', reason: 'read does not need ownership' }))
    acquire.mockClear()
    const listRecords = vi.spyOn(store, 'listRecords')
    // Childless restored chats reach live lists only through restore publication.
    const listed: AgentSessionStatusEvent[] = []
    host.subscribeStatus({ id: 'session-list', emit: (event) => listed.push(event) })

    await host.restoreReadableSessions()
    expect(listed.at(-1)).toEqual({
      type: 'status',
      session: expect.objectContaining({ sessionId: SESSION, status: 'idle' })
    })
    const restoreReads = listRecords.mock.calls.length
    await host.restoreReadableSessions()

    expect(host.listSessionTabs()).toEqual([
      { sessionId: SESSION, workspaceId: 'workspace-1', agent: 'codex' }
    ])
    const history = await host.history({ sessionId: SESSION, direction: 'tail' })
    expect(history.ok && history.page.items).not.toHaveLength(0)
    expect(acquire).not.toHaveBeenCalled()
    expect(listRecords).toHaveBeenCalledTimes(restoreReads)
  })

  it('clears a stale conflicted recovery at restart, and reacquires the native owner on the next start', async () => {
    await attach()
    await store.transitionHandoff(SESSION, (record) => ({
      ...record,
      lease: {
        ...record.lease,
        // Legacy terminal ownership loads conflicted.
        claimStatus: 'conflicted',
        handoffStage: 'recovering'
      }
    }))
    await reboot(async () => ({ outcome: 'pid-absent' }))
    acquire.mockClear()

    await host.restoreReadableSessions()
    // Startup recovers the lease; work must still start the child.
    const fence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    expect(await host.attach(CALLER, ensureParams(fence))).toMatchObject({ ok: true })

    expect(acquire).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeKind: 'native',
      claimStatus: 'live',
      handoffStage: null,
      handoffOperationId: null
    })
    expect(host.handoffStatus(SESSION)).toMatchObject({
      owner: 'native',
      phase: 'idle',
      stage: null
    })
  })

  it('answers native for a chat whose start is still in flight', async () => {
    await attach()
    await reboot(async () => ({ outcome: 'pid-absent' }))
    await host.restoreReadableSessions()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const settled = acquire.getMockImplementation()
    if (!settled) {
      throw new Error('missing acquire implementation')
    }
    acquire.mockImplementationOnce(async (input) => {
      started.resolve()
      await release.promise
      return settled(input)
    })

    const start = host.attach(
      CALLER,
      ensureParams(store.getRecord(SESSION)?.lease.runtimeFence ?? 0)
    )
    await started.promise
    const claimMidStart = store.getRecord(SESSION)?.lease.claimStatus
    const status = host.handoffStatus(SESSION)
    release.resolve()
    await start

    expect(claimMidStart).toBe('reserved')
    expect(status).toMatchObject({ owner: 'native' })
  })

  it('reads stored ownership even when this host cannot start the provider', async () => {
    await attach()

    await reboot(async () => ({ outcome: 'pid-absent' }), { supportsCreate: () => false })
    expect(host.handoffStatus(SESSION)).toMatchObject({ owner: 'native' })
  })

  it('releases a session whose owner can never be probed, signalling nothing, and starts over', async () => {
    await attach()
    const held = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    const stopOwnerProcess = vi.fn()
    await reboot(
      async () => ({ outcome: 'indeterminate', reason: 'no probe on this host' }),
      {},
      stopOwnerProcess
    )
    acquire.mockClear()

    expect(await host.attach(CALLER, ensureParams(await staleFenceFrom(held)))).toMatchObject({
      ok: true
    })
    expect(acquire).toHaveBeenCalledOnce()
    // Unverified PIDs may belong to unrelated processes.
    expect(stopOwnerProcess).not.toHaveBeenCalled()
  })

  it('does not remember a failed adjudication as done', async () => {
    const before = await attach()
    const held = before?.lease.runtimeFence ?? 0
    const probe = vi
      .fn<(record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>>()
      .mockRejectedValueOnce(new Error('probe exploded'))
      .mockResolvedValue({ outcome: 'pid-absent' })
    await reboot(probe)

    await expect(host.attach(CALLER, ensureParams(held))).rejects.toThrow('probe exploded')
    const reattached = await host.attach(CALLER, ensureParams(await staleFenceFrom(held)))
    expect(reattached).toMatchObject({ ok: true })
    expect(probe).toHaveBeenCalledTimes(2)
  })
})

describe('subscribe', () => {
  it('opens with a snapshot and then streams cursor-qualified batches', async () => {
    await attach()
    const events: AgentSessionSubscribeEvent[] = []
    const dispose = await host.subscribe({
      id: 'sub-1',
      sessionId: SESSION,
      emit: (event) => events.push(event)
    })
    const body = hostTestMessage('add a retry')
    await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })

    expect(events[0]?.type).toBe('snapshot')
    const batches = events.filter((event) => event.type === 'batch')
    expect(batches.length).toBeGreaterThan(0)
    const last = batches.at(-1)
    expect(last?.type === 'batch' && last.batch.cursor.sequence).toBeGreaterThan(0)

    dispose()
    expect(events.at(-1)?.type).toBe('end')
  })

  it('resumes from a client cursor with only the rows it missed', async () => {
    await attach()
    const body = hostTestMessage('add a retry')
    const first = await host.send(CALLER, {
      envelope: envelope('agentSession.send', { body }),
      body
    })
    if (!first.ok) {
      throw new Error(`expected a send, got ${first.refusal.code}`)
    }

    const events: AgentSessionSubscribeEvent[] = []
    await host.subscribe({
      id: 'sub-2',
      sessionId: SESSION,
      emit: (event) => events.push(event),
      cursor: first.cursor
    })
    expect(events[0]).toMatchObject({ type: 'batch' })
    expect(events[0]).not.toHaveProperty('handoff')

    const second = hostTestMessage('and a timeout')
    await host.send(CALLER, {
      envelope: envelope('agentSession.send', { body: second }),
      body: second
    })
    expect(events.some((event) => event.type === 'batch')).toBe(true)
    expect(events.some((event) => event.type === 'snapshot')).toBe(false)
  })

  it('drops a failed transport without aborting the mutation or other subscribers', async () => {
    await attach()
    const events: AgentSessionSubscribeEvent[] = []
    await host.subscribe({
      id: 'dead-sub',
      sessionId: SESSION,
      emit: () => {
        throw new Error('socket closed')
      }
    })
    await host.subscribe({
      id: 'live-sub',
      sessionId: SESSION,
      emit: (event) => events.push(event)
    })
    const body = hostTestMessage('survive subscriber failure')

    const result = await host.send(CALLER, {
      envelope: envelope('agentSession.send', { body }),
      body
    })

    expect(result).toMatchObject({ ok: true, value: { submission: { dispatchState: 'pending' } } })
    // Failed subscriber transport must not block provider delivery or healthy subscribers.
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) =>
            event.type === 'batch' &&
            event.batch.submissions?.some((entry) => entry.dispatchState === 'accepted')
        )
      ).toBe(true)
    )
  })

  it('resets a subscriber whose epoch is gone', async () => {
    await attach()
    const events: AgentSessionSubscribeEvent[] = []
    await host.subscribe({
      id: 'sub-3',
      sessionId: SESSION,
      emit: (event) => events.push(event),
      cursor: { epoch: 'epoch-from-a-previous-life', sequence: 3 }
    })
    expect(events[0]).toMatchObject({ type: 'reset', reset: 'epoch_changed', fence: 1 })
  })

  it('publishes the replacement fence when the owner generation changes', async () => {
    const record = await attach()
    const events: AgentSessionSubscribeEvent[] = []
    await host.subscribe({
      id: 'sub-4',
      sessionId: SESSION,
      emit: (event) => events.push(event)
    })
    const released = await store.evictProvenDeadOwner({
      sessionId: SESSION,
      expectedFence: record?.lease.runtimeFence ?? 1,
      probe: { outcome: 'pid-absent' },
      now: NOW
    })

    const replacement = await host.attach(CALLER, ensureParams(released.lease.runtimeFence))
    if (!replacement.ok) {
      throw new Error(`expected replacement owner, got ${replacement.refusal.code}`)
    }
    expect(events.findLast((event) => event.type === 'snapshot')?.fence).toBe(replacement.fence)
    expect(events.at(-1)).toMatchObject({ fence: replacement.fence })
  })
})
