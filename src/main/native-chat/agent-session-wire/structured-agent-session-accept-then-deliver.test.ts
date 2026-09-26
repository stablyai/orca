import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
// A send is accepted, then delivered: the host answers once the message is recorded, and the
// session's delivery loop starts a provider child for it and hands it over. Against the real host,
// store and journal; each assertion reads what an open chat or the journal's next reader sees.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentSessionSubscribeEvent,
  AgentSessionTurnCompletionEvent
} from '../../../shared/agent-session-wire'
import {
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_HOST_RESTARTED,
  DISPATCH_REJECTED_PROVIDER_CLOSED
} from '../../../shared/structured-agent-session-dispatch-rejection'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { journalDirectoryFor } from '../agent-session-journal/journal-paths'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import {
  AgentSessionPreSpawnError,
  type StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import { journalIdentityFor } from './structured-agent-session-attach'
import { attachParamsForRecord } from './structured-agent-session-conversation-open'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { persistRewindRecord } from './structured-rewind-recovery'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }

function eventually(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let adapterExtras: Partial<StructuredAgentSessionAdapter>
let idleMs: number

const spawnChild: StructuredAgentSessionAdapter['acquire'] = async ({ fence, spawnToken }) => ({
  process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
  acquisitionGeneration: `generation-${acquire.mock.calls.length}`,
  link: {
    linkId: `link-${fence}`,
    handle: { provider: 'codex' as const, threadId: THREAD },
    origin: store.getRecord(SESSION)?.providerHandleChain.length
      ? ('resumed' as const)
      : ('created' as const),
    mintedAtFence: fence,
    observedAt: NOW
  }
})

async function startHost(): Promise<void> {
  host = new StructuredAgentSessionHost({
    store,
    adapter: {
      acquire,
      dispatch,
      closeSession: vi.fn(async () => true),
      releaseAcquisition: vi.fn(async () => true),
      cancelTurn: vi.fn(async () => ({ cancelled: false })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined),
      ...adapterExtras
    },
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${acquire.mock.calls.length}`,
    idleSweep: { intervalMs: 5, idleMs },
    now: () => NOW
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-accept-deliver-'))
  resetHostTestOperationIds()
  adapterExtras = {}
  idleMs = 60 * 60_000
  acquire = vi.fn(spawnChild)
  dispatch = vi.fn(async () => ({
    state: 'accepted' as const,
    providerIdentity: {
      provider: 'codex' as const,
      threadId: THREAD,
      turnId: `turn-${dispatch.mock.calls.length}`,
      ordinal: dispatch.mock.calls.length
    }
  }))
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  await startHost()
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function sendParams(text: string) {
  const body = hostTestMessage(text)
  return {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: 1,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  }
}

/** Accepted at once, whatever the child is doing; answers the message id. */
async function accept(text: string): Promise<string> {
  const params = sendParams(text)
  expect(await host.send(CALLER, params)).toMatchObject({
    ok: true,
    value: { submission: { dispatchState: 'pending', handoverRecorded: true } }
  })
  return params.envelope.clientOperationId
}

function stop() {
  const turnId = 'turn-none'
  return host.cancel(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: null,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.cancel',
        sessionId: SESSION,
        fields: { turnId }
      })
    },
    turnId
  })
}

async function submission(id: string): Promise<AgentJournalSubmission | undefined> {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === id
  )
}

/** Read back after the conversation was closed, through the same open any reader takes. */
async function reopened(id: string): Promise<AgentJournalSubmission | undefined> {
  await host.revealSession(SESSION)
  return submission(id)
}

async function errorRows(): Promise<string[]> {
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'status' && item.body.tone === 'error' ? [item.body.text] : []
  )
}

let subscriptions = 0

async function subscribe(): Promise<AgentSessionSubscribeEvent[]> {
  const events: AgentSessionSubscribeEvent[] = []
  subscriptions += 1
  // Cloned as received: a frame shares the journal's live objects, which later rows revise.
  await host.subscribe({
    id: `sub-${subscriptions}`,
    sessionId: SESSION,
    emit: (event) => events.push(structuredClone(event))
  })
  return events
}

/** What an open chat was told about one message, in frame order. */
function framedStates(events: AgentSessionSubscribeEvent[], id: string): string[] {
  return events.flatMap((event) =>
    event.type === 'batch'
      ? event.batch.submissions
          .filter((entry) => entry.clientMessageId === id)
          .map((entry) =>
            entry.dispatchState === 'pending' && entry.handedOverAt !== undefined
              ? 'handed-over'
              : entry.dispatchState
          )
      : []
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}

/** Rows written by an earlier host process that ended before handing them over. */
async function writeAsEarlierProcess(
  write: (journal: AgentSessionJournal, fence: number) => Promise<void>
): Promise<void> {
  await host.close(SESSION)
  const record = store.getRecord(SESSION)!
  const params = attachParamsForRecord(record, {
    clientOperationId: 'earlier',
    expectedRuntimeFence: record.lease.runtimeFence
  })
  const journal = await openAgentSessionJournal({
    identity: journalIdentityFor(record, params),
    journalDir: journalDirectoryFor(root, {
      workspaceId: record.location.workspaceId,
      sessionId: SESSION
    })
  })
  await write(journal, record.lease.runtimeFence)
  await journal.close()
}

function earlierSubmission(id: string, text: string, handoverRecorded?: true) {
  const body = hostTestMessage(text)
  return {
    clientMessageId: id,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId: SESSION,
      fields: { body }
    }),
    body,
    ...(handoverRecorded ? { handoverRecorded } : {})
  }
}

describe('a send is answered at acceptance', () => {
  it('answers before the child starts, then an open chat sees the handover and the reply (W2)', async () => {
    await host.close(SESSION)
    const starting = deferred<void>()
    acquire.mockImplementationOnce(async (input) => {
      await starting.promise
      return spawnChild(input)
    })

    const answering = deferred<void>()
    const answer = dispatch.getMockImplementation()!
    dispatch.mockImplementationOnce(async (input) => {
      await answering.promise
      return answer(input)
    })

    const id = await accept('hello')
    const events = await subscribe()
    await eventually(async () => expect(acquire).toHaveBeenCalledTimes(2))
    expect(dispatch).not.toHaveBeenCalled()

    starting.resolve()
    await eventually(async () => expect(framedStates(events, id)).toEqual(['handed-over']))
    answering.resolve()
    await eventually(async () =>
      expect(framedStates(events, id)).toEqual(['handed-over', 'accepted'])
    )
  })

  it('accepts a second send while the first one starts the child, before handing either over (W6)', async () => {
    await host.close(SESSION)
    const starting = deferred<void>()
    acquire.mockImplementationOnce(async (input) => {
      await starting.promise
      return spawnChild(input)
    })
    const first = await accept('first')
    await eventually(async () => expect(acquire).toHaveBeenCalledTimes(2))
    const second = host.send(CALLER, sendParams('second'))

    starting.resolve()
    const secondResult = await second
    if (!secondResult.ok) {
      throw new Error('the second send was refused')
    }
    const secondId = secondResult.value.clientMessageId
    await eventually(async () =>
      expect((await submission(secondId))?.dispatchState).toBe('accepted')
    )
    expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([first, secondId])
    // The second was accepted while the start held the queue — before the first was handed over.
    expect((await submission(secondId))!.submittedAt).toBeLessThanOrEqual(
      (await submission(first))!.handedOverAt!
    )
    const rows = (await host.journalSnapshot(SESSION)).submissions
    expect(rows.map((row) => row.clientMessageId)).toEqual([first, secondId])
  })
})

describe('a start the chat needed and did not get', () => {
  it('writes one error row and rejects every queued message with it; the next send starts (W3)', async () => {
    await host.close(SESSION)
    acquire.mockRejectedValueOnce(new Error('spawn codex ENOENT'))
    const first = await accept('first')
    const second = await accept('second')

    await eventually(async () => expect((await submission(second))?.dispatchState).toBe('rejected'))
    const rows = await errorRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('spawn codex ENOENT')
    expect(await submission(first)).toMatchObject({ dispatchState: 'rejected', reason: rows[0] })
    expect(await submission(second)).toMatchObject({ dispatchState: 'rejected', reason: rows[0] })

    const next = await accept('after the fix')
    await eventually(async () => expect((await submission(next))?.dispatchState).toBe('accepted'))
    expect(await errorRows()).toHaveLength(1)
  })

  it('notifies failed once for the queued messages one start failure refused', async () => {
    await host.close(SESSION)
    acquire.mockRejectedValueOnce(new Error('spawn codex ENOENT'))
    const completions: AgentSessionTurnCompletionEvent[] = []
    host.subscribeTurnCompletions({ id: 'dot-1', emit: (event) => completions.push(event) })
    await accept('first')
    const second = await accept('second')

    await eventually(async () => expect((await submission(second))?.dispatchState).toBe('rejected'))
    await host.flushAllStreamedEvents()
    expect(completions).toEqual([
      {
        type: 'completion',
        completion: expect.objectContaining({
          sessionId: SESSION,
          turnId: agentJournalSubmissionKey(second),
          outcome: 'failure'
        })
      }
    ])
  })

  it.each([
    [
      'eligibility',
      () => {
        adapterExtras = { supportsLocation: () => false }
      },
      'cannot resume'
    ],
    [
      'spawn',
      () => acquire.mockRejectedValueOnce(new Error('spawn codex ENOENT')),
      'spawn codex ENOENT'
    ],
    [
      'auth',
      () =>
        acquire.mockRejectedValueOnce(
          new AgentSessionPreSpawnError(new Error('Not logged in. Please run /login.'))
        ),
      'Not logged in'
    ]
  ])('writes one row a live chat sees for a %s refusal (W14)', async (_source, arrange, cause) => {
    await host.close(SESSION)
    arrange()
    await host.flushAllStreamedEvents()
    await startHost()
    const id = await accept('hello')
    const events = await subscribe()

    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'))
    expect(await errorRows()).toHaveLength(1)
    expect((await errorRows())[0]).toContain(cause)
    const framedRows = events.flatMap((event) =>
      event.type === 'batch' || event.type === 'snapshot'
        ? (event.type === 'batch' ? event.batch.items : event.page.items).filter(
            (item) => item.body.kind === 'status' && item.body.tone === 'error'
          )
        : []
    )
    expect(framedRows.length).toBeGreaterThan(0)
  })

  it('names the start failure on queued messages when the attach fails after acquiring (W4′a)', async () => {
    await host.close(SESSION)
    const id = await accept('hello')
    // The attach's own success record is the post-acquisition step that fails.
    const record = vi.spyOn(store, 'recordOperationOutcome')
    record.mockImplementation(async (input) => {
      if (input.operationId !== id && input.outcome.status === 'succeeded') {
        record.mockRestore()
        throw new Error('record store write failed')
      }
      return AgentSessionRecordStore.prototype.recordOperationOutcome.call(store, input)
    })

    // Read through the open any reader takes, so a conversation the failure dropped is reopened
    // and its message read as that reopen settles it.
    let settled: AgentJournalSubmission | undefined
    await eventually(async () => {
      settled = await reopened(id)
      expect(settled?.dispatchState).not.toBe('pending')
    })
    // The message names the start that failed, not a close or a restart it never met.
    expect(settled).toMatchObject({
      dispatchState: 'rejected',
      reason: expect.stringContaining('record store write failed')
    })
    expect(await errorRows()).toEqual([settled?.reason])
  })
})

describe('an attach that fails after indexing its child', () => {
  it('leaves no child behind, so the next send starts one and is delivered', async () => {
    await host.close(SESSION)
    const owned: boolean[] = []
    host.subscribeStatus({
      id: 'list-1',
      emit: (event) => {
        if (event.type === 'status') {
          owned.push(event.session.hostExecutionOwned === true)
        }
      }
    })
    const first = await accept('hello')
    // The attach's own success record is the step after `onAttached` indexed the child.
    const record = vi.spyOn(store, 'recordOperationOutcome')
    record.mockImplementation(async (input) => {
      if (input.operationId !== first && input.outcome.status === 'succeeded') {
        record.mockRestore()
        throw new Error('record store write failed')
      }
      return AgentSessionRecordStore.prototype.recordOperationOutcome.call(store, input)
    })
    await eventually(async () => expect((await submission(first))?.dispatchState).toBe('rejected'))
    // Nothing was indexed, so nothing had to be taken back: no list ever showed a child.
    expect(host['sessions'].get(SESSION)?.child).toBeNull()
    expect(owned).not.toContain(true)
    const acquiresBefore = acquire.mock.calls.length

    const next = await accept('after the failure')

    await eventually(async () => expect((await submission(next))?.dispatchState).toBe('accepted'))
    expect(acquire).toHaveBeenCalledTimes(acquiresBefore + 1)
    expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([next])
  })
})

describe('what an earlier host process left behind', () => {
  it('rejects a message it accepted and never handed over, as not sent (W4′b)', async () => {
    await writeAsEarlierProcess(async (journal, fence) => {
      await journal.appendSubmission({ ...earlierSubmission('queued', 'q', true), fence })
    })

    await host.revealSession(SESSION)

    expect(await submission('queued')).toMatchObject({
      dispatchState: 'rejected',
      reason: DISPATCH_REJECTED_HOST_RESTARTED
    })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('leaves a legacy pending message and a handed-over one in doubt, never re-sent (W4′c)', async () => {
    const providerHistoryWindow = vi.fn(async () => null)
    adapterExtras = { providerHistoryWindow }
    await writeAsEarlierProcess(async (journal, fence) => {
      await journal.appendSubmission({ ...earlierSubmission('legacy', 'l'), fence })
      await journal.appendSubmission({ ...earlierSubmission('handed', 'h', true), fence })
      await journal.resolveDispatch({
        clientMessageId: 'handed',
        state: 'pending',
        fence,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    })
    await host.flushAllStreamedEvents()
    await startHost()

    await host.revealSession(SESSION)

    expect(await submission('legacy')).toMatchObject({ dispatchState: 'unknown', recovered: true })
    expect(await submission('handed')).toMatchObject({ dispatchState: 'unknown', recovered: true })
    // Deciding them from provider history waits for a won lease (W4′d).
    expect(providerHistoryWindow).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('a child that exits before its message is handed over', () => {
  it('rejects the message with the exit reason instead of starting another child (W24)', async () => {
    // Each child the loop starts dies between its start step and its handover step.
    const awaitStarted = vi.fn(async (sessionId: string) => {
      await host.handleAdapterEvent({
        type: 'ended',
        sessionId,
        fence: store.getRecord(sessionId)!.lease.runtimeFence,
        acquisitionGeneration: `generation-${acquire.mock.calls.length}`,
        reason: 'codex app-server crashed',
        cause: 'unexpected-exit'
      })
    })
    adapterExtras = { awaitStarted }
    await host.close(SESSION)
    await startHost()

    const id = await accept('hello')

    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'))
    expect((await submission(id))?.reason).toContain('codex app-server crashed')
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('Stop withdraws what is queued', () => {
  it('withdraws a crash leftover ahead of any delivery step (W17a)', async () => {
    await writeAsEarlierProcess(async (journal, fence) => {
      await journal.appendSubmission({ ...earlierSubmission('leftover', 'l', true), fence })
    })

    // Stop's own open wakes the delivery loop, whose first step queues behind this Stop.
    expect(await stop()).toMatchObject({ ok: true })

    expect(await submission('leftover')).toMatchObject({
      dispatchState: 'rejected',
      reason: DISPATCH_REJECTED_CANCELLED
    })
    expect(acquire).toHaveBeenCalledTimes(1)
  })

  it('withdraws a message whose start holds the queue: nothing is handed over (W17b)', async () => {
    await host.close(SESSION)
    const starting = deferred<void>()
    acquire.mockImplementationOnce(async (input) => {
      await starting.promise
      return spawnChild(input)
    })
    const id = await accept('hello')
    await eventually(async () => expect(acquire).toHaveBeenCalledTimes(2))
    const stopped = stop()

    starting.resolve()
    expect(await stopped).toMatchObject({ ok: true })
    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'))
    expect(await submission(id)).toMatchObject({ reason: DISPATCH_REJECTED_CANCELLED })
    expect((await submission(id))?.handedOverAt).toBeUndefined()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('stops a child still proving its start, and the delivery loop ends with it (W17c)', async () => {
    const ended = deferred<void>()
    const awaitStarted = vi.fn(() => ended.promise)
    const closeSession = vi.fn(async () => {
      ended.resolve()
      return true
    })
    adapterExtras = { awaitStarted, closeSession }
    await host.close(SESSION)
    await startHost()
    acquire.mockImplementationOnce(async (input) => ({
      ...(await spawnChild(input)),
      providerChildPhase: 'starting' as const
    }))
    const id = await accept('hello')
    await eventually(async () => expect(awaitStarted).toHaveBeenCalled())

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })

    expect(await reopened(id)).toMatchObject({
      dispatchState: 'rejected',
      reason: DISPATCH_REJECTED_CANCELLED
    })
    expect(closeSession).toHaveBeenCalled()
    // A loop still waiting on that start would swallow this send; it starts a new child instead.
    awaitStarted.mockImplementation(async () => undefined)
    const next = await accept('after stop')
    await eventually(async () => expect((await submission(next))?.dispatchState).toBe('accepted'))
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
})

describe('an eviction between acceptance and handover', () => {
  it('rejects the message as not sent, never leaves it in doubt (W24)', async () => {
    const started = deferred<void>()
    adapterExtras = { awaitStarted: () => started.promise }
    await host.close(SESSION)
    await startHost()
    const id = await accept('hello')
    await eventually(async () => expect(acquire).toHaveBeenCalledTimes(2))
    // Between the delivery loop's start step and its handover step.
    await host.close(SESSION)
    started.resolve()

    expect(await reopened(id)).toMatchObject({
      dispatchState: 'rejected',
      reason: DISPATCH_REJECTED_PROVIDER_CLOSED
    })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('rejects a queued message behind a handed-over one, which alone stays in doubt (W24)', async () => {
    const second = deferred<void>()
    const awaitStarted = vi.fn(async (): Promise<void> => undefined)
    adapterExtras = { awaitStarted }
    await host.close(SESSION)
    await startHost()
    dispatch.mockResolvedValueOnce({ state: 'admitted' })
    const handed = await accept('handed over')
    await eventually(async () => expect((await submission(handed))?.handedOverAt).toBeDefined())
    awaitStarted.mockImplementation(() => second.promise)
    const queued = await accept('still queued')
    await eventually(async () => expect(awaitStarted).toHaveBeenCalledTimes(2))

    await host.close(SESSION)
    second.resolve()

    expect(await reopened(queued)).toMatchObject({
      dispatchState: 'rejected',
      reason: DISPATCH_REJECTED_PROVIDER_CLOSED
    })
    expect(await submission(handed)).toMatchObject({ dispatchState: 'unknown' })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('does not stop an idle child while a message is still queued for it (W24)', async () => {
    idleMs = 0
    const started = deferred<void>()
    adapterExtras = { awaitStarted: () => started.promise }
    await host.close(SESSION)
    await startHost()
    const id = await accept('hello')
    await eventually(async () => expect(acquire).toHaveBeenCalledTimes(2))
    // The idle sweep ticks every few milliseconds meanwhile.
    await new Promise((resolve) => setTimeout(resolve, 20))

    started.resolve()
    // Handed to the child it was queued for; the eviction may follow once nothing is owed.
    await eventually(async () => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(dispatch.mock.calls[0]?.[0].clientMessageId).toBe(id)
    expect(acquire).toHaveBeenCalledTimes(2)
  })
})

describe('a compaction or rewind an earlier child left prepared', () => {
  async function leftPrepared(prepare: (fence: number) => Promise<unknown>): Promise<void> {
    await host.close(SESSION)
    await prepare(store.getRecord(SESSION)!.lease.runtimeFence)
    // A new process: nothing is open and no view attaches.
    await host.flushAllStreamedEvents()
    await startHost()
  }

  it("ignores an older build's interrupted compaction, so a send is accepted and delivered (R16)", async () => {
    await leftPrepared((fence) =>
      store.setConversationCommand(SESSION, fence, {
        command: 'compact',
        runtimeFence: fence,
        operationId: 'compact-op',
        callerKey: 'client-1',
        phase: 'prepared',
        state: 'unknown'
      })
    )

    const id = await accept('after the compaction')

    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('accepted'))
    // Nothing settles the record: it belongs to a child this host no longer runs.
    expect(store.getRecord(SESSION)?.conversationCommand).toMatchObject({ phase: 'prepared' })
  })

  it('completes a rewind the provider already applied at open, so a send is accepted (R16)', async () => {
    await leftPrepared((fence) =>
      persistRewindRecord(store, SESSION, fence, {
        operationId: 'rewind-op',
        callerKey: 'client-1',
        itemId: 'orca:rewound',
        providerItemId: `codex:${THREAD}:turn-1:0`,
        expectedEpoch: 'epoch-before',
        phase: 'provider-succeeded',
        hydrationVerified: true,
        retained: []
      })
    )

    const id = await accept('after the rewind')

    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('accepted'))
    expect(store.getRecord(SESSION)?.rewind).toMatchObject({ phase: 'completed' })
  })
})
