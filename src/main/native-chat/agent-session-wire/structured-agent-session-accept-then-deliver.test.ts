import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
// A send is accepted, then delivered: the host answers once the message is recorded, and the
// session's delivery loop starts a provider child for it and hands it over. Against the real host,
// store and journal; each assertion reads what an open chat or the journal's next reader sees.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { projectStructuredAgentSessionMessages } from '../../../shared/structured-agent-session-message-projection'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionSubscribeEvent,
  AgentSessionTurnCompletionEvent
} from '../../../shared/agent-session-wire'
import {
  classifyDispatchRejection,
  DISPATCH_REJECTED_CANCELLED
} from '../../../shared/structured-agent-session-dispatch-rejection'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import {
  AgentSessionPreSpawnError,
  type StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import { journalIdentityFor } from './structured-agent-session-attach'
import { attachParamsForRecord } from './structured-agent-session-conversation-open'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionChildEndCause } from './structured-agent-session-host-types'
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
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { StructuredAgentArgumentsError } from '../structured-agent-arguments-error'
import { USER_MESSAGE_SOURCE } from '../../../shared/agent-session-message-source'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

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
    handle: codexProviderHandle(THREAD),
    origin: store.getRecord(SESSION)?.providerHandleChain.length
      ? ('resumed' as const)
      : ('created' as const),
    mintedAtFence: fence,
    observedAt: NOW
  }
})

async function startHost(): Promise<void> {
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
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
    journalDatabase: openTestJournalHostDatabase(root),
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
  store = await openTestAgentSessionRecordStore(root)
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
  await host.close(SESSION, 'evict')
  const record = store.getRecord(SESSION)!
  const params = attachParamsForRecord(record, {
    clientOperationId: 'earlier',
    expectedRuntimeFence: record.lease.runtimeFence
  })
  const journal = await openAgentSessionJournal({
    identity: journalIdentityFor(record, params),
    database: openTestJournalHostDatabase(root)
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
    await host.close(SESSION, 'evict')
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
    await host.close(SESSION, 'evict')
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
  it('shows a saved Arguments refusal on the resumed chat row and rejected message', async () => {
    await host.close(SESSION, 'evict')
    acquire.mockRejectedValueOnce(
      new AgentSessionPreSpawnError(
        new StructuredAgentArgumentsError('Codex', '--unsafe=private', 'unsupportedOption')
      )
    )
    const id = await accept('first')
    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'))
    const sentence =
      "Codex couldn't restart. Saved Arguments contain an unsupported option (--unsafe). Edit them in Settings > Agents > Arguments. Send your message to try again."
    expect(await errorRows()).toEqual([sentence])
    expect(await submission(id)).toMatchObject({
      reason: sentence,
      rejection: {
        kind: 'restartFailed',
        argumentProblem: { agent: 'Codex', option: '--unsafe', problem: 'unsupportedOption' }
      }
    })
    expect(JSON.stringify(await host.journalSnapshot(SESSION))).not.toContain('private')
  })

  it('rejects only the message whose start failed; the one behind it starts and is delivered (W3)', async () => {
    await host.close(SESSION, 'evict')
    acquire.mockRejectedValueOnce(new Error('spawn codex ENOENT'))
    const first = await accept('first')
    const second = await accept('second')

    await eventually(async () => expect((await submission(second))?.dispatchState).toBe('accepted'))
    // Orca's spawn error goes to the log; the message says what failed, typed. The child is gone,
    // but no exit was observed, so nothing blames the provider.
    expect(await submission(first)).toMatchObject({
      dispatchState: 'rejected',
      reason: "Codex couldn't restart. Send your message to try again.",
      rejection: {
        kind: 'restartFailed',
        refusal: { code: 'agent_session_operation_invalid', details: { ownerVerdict: 'exited' } }
      }
    })
    // The failed start's one row, which a client that hides rejected messages still shows.
    expect(await errorRows()).toEqual(["Codex couldn't restart. Send your message to try again."])
    expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([second])
  })

  // A client that hides rejected messages — a released desktop, any phone — still reads why.
  it('leaves the failure in the transcript of a client that hides a rejected message sent elsewhere', async () => {
    await host.close(SESSION, 'evict')
    acquire.mockRejectedValueOnce(new Error('spawn codex ENOENT'))
    const id = await accept('from another device')
    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'))

    const snapshot = await host.journalSnapshot(SESSION)
    const drawn = projectStructuredAgentSessionMessages(snapshot.items, [], snapshot.submissions, {
      rejectedInPlace: false
    })
    expect(drawn.map((message) => message.id)).not.toContain(agentJournalSubmissionKey(id))
    expect(drawn.flatMap((message) => message.blocks)).toContainEqual(
      expect.objectContaining({ text: "Codex couldn't restart. Send your message to try again." })
    )
  })

  // Messages sent straight to the chat, not queued as cards: each makes its own start, and the
  // session announces once, when it owes nothing more.
  it('notifies once, for the last, when sent messages whose starts all fail alike are each rejected', async () => {
    await host.close(SESSION, 'evict')
    acquire.mockRejectedValue(new Error('spawn codex ENOENT'))
    const completions: AgentSessionTurnCompletionEvent[] = []
    host.subscribeTurnCompletions({ id: 'dot-1', emit: (event) => completions.push(event) })
    const first = await accept('first')
    const second = await accept('second')
    const third = await accept('third')

    await eventually(async () => expect((await submission(third))?.dispatchState).toBe('rejected'))
    // Each message made its own start.
    for (const id of [first, second, third]) {
      expect(await submission(id)).toMatchObject({
        dispatchState: 'rejected',
        rejection: { kind: 'restartFailed' }
      })
    }
    expect(acquire.mock.calls.length).toBeGreaterThanOrEqual(4)
    // One row for the run: the starts all failed alike, with nothing delivered between.
    expect(await errorRows()).toHaveLength(1)
    await host.flushAllStreamedEvents()
    expect(completions).toEqual([
      {
        type: 'completion',
        completion: expect.objectContaining({
          sessionId: SESSION,
          turnId: agentJournalSubmissionKey(third),
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
      {
        text: "Codex couldn't restart. Start a new chat to continue.",
        failure: {
          kind: 'restartFailed',
          refusal: {
            code: 'structured_agent_session_unsupported',
            details: { reason: 'hostUnsupported' }
          }
        }
      }
    ],
    [
      'spawn',
      () => acquire.mockRejectedValueOnce(new Error('spawn codex ENOENT')),
      {
        text: "Codex couldn't restart. Send your message to try again.",
        failure: {
          kind: 'restartFailed',
          refusal: { code: 'agent_session_operation_invalid', details: { ownerVerdict: 'exited' } }
        }
      }
    ],
    [
      'auth',
      () =>
        acquire.mockRejectedValueOnce(
          new AgentSessionPreSpawnError(new Error('Not logged in. Please run /login.'))
        ),
      {
        // No process ever started, so nothing says the provider stopped.
        text: "Codex couldn't restart. Send your message to try again.",
        failure: {
          kind: 'restartFailed',
          refusal: { code: 'agent_session_operation_invalid', details: { ownerVerdict: 'exited' } }
        }
      }
    ]
  ])(
    "tells a live chat a %s refusal on the message it failed, beside the start's one row (W14)",
    async (_source, arrange, expected) => {
      await host.close(SESSION, 'evict')
      arrange()
      await host.flushAllStreamedEvents()
      await startHost()
      const id = await accept('hello')
      const events = await subscribe()

      const told = () =>
        events.flatMap((event) =>
          event.type === 'batch'
            ? event.batch.submissions.filter((entry) => entry.clientMessageId === id)
            : []
        )
      await eventually(() =>
        expect(told().at(-1)).toMatchObject({
          dispatchState: 'rejected',
          reason: expected.text,
          rejection: expected.failure
        })
      )
      expect(await errorRows()).toEqual([expected.text])
    }
  )

  it('names the start failure on the queued message when the attach fails after acquiring (W4′a)', async () => {
    await host.close(SESSION, 'evict')
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
    // The message names the start that failed, not a close or a restart it never met — and never
    // the store's own error, which is Orca's and goes to the log.
    expect(settled).toMatchObject({
      dispatchState: 'rejected',
      rejection: { kind: 'restartFailed' }
    })
    expect(settled?.reason).not.toContain('record store write failed')
    expect(await errorRows()).toEqual([settled?.reason])
  })
})

describe('an attach that fails after indexing its child', () => {
  it('leaves no child behind, so the next send starts one and is delivered', async () => {
    await host.close(SESSION, 'evict')
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
      ...agentSessionFailureWords(agentSessionFailureFact('hostRestarted'), {
        surface: 'rejection'
      })
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
    await host.close(SESSION, 'evict')
    await startHost()
    // Each child the loop starts dies as its start step returns: its exit, asked for on the lane
    // then, lands before the handover step.
    acquire.mockImplementation(async (input) => {
      const child = await spawnChild(input)
      void host.handleAdapterEvent({
        type: 'ended',
        sessionId: SESSION,
        fence: input.fence,
        acquisitionGeneration: `generation-${acquire.mock.calls.length}`,
        reason: 'codex app-server crashed',
        cause: 'unexpected-exit'
      })
      return child
    })

    const id = await accept('hello')

    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'))
    expect(await submission(id)).toMatchObject({
      reason: 'Codex stopped before this message was sent.',
      rejection: { kind: 'providerExited' }
    })
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('a start that fails after it was handed messages', () => {
  it('keeps one row in the words its rejected messages carry, each from its own start', async () => {
    // A starting child takes the first at once; the second waits until that turn opens, which it
    // never does. Neither is answered.
    dispatch.mockImplementation(async () => ({ state: 'admitted' as const }))
    acquire.mockImplementation(async (input) => ({
      ...(await spawnChild(input)),
      providerChildPhase: 'starting' as const
    }))
    await host.close(SESSION, 'evict')
    await startHost()
    // The latest child exits before it proves its start, with the CLI's own words for why.
    const exitDuringStart = () =>
      host.handleAdapterEvent({
        type: 'ended',
        sessionId: SESSION,
        fence: store.getRecord(SESSION)!.lease.runtimeFence,
        acquisitionGeneration: `generation-${acquire.mock.calls.length}`,
        reason: 'codex app-server exited with code 1',
        failure: agentSessionFailureFact('providerStartFailed', {
          detail: { text: 'codex: config.toml is invalid', audience: 'person' }
        }),
        cause: 'unexpected-exit',
        startupUnproven: true
      })

    const first = await accept('first')
    const second = await accept('second')
    await eventually(() => expect(dispatch).toHaveBeenCalledTimes(1))
    // The second's pass found nothing to hand over yet, so it waits on no start.
    await eventually(() => expect(host['conversationDelivery'].loop.isRunning(SESSION)).toBe(false))
    await exitDuringStart()

    // The held message was never handed to that child: it gets a start of its own, which fails alike.
    await eventually(() => expect(dispatch).toHaveBeenCalledTimes(2))
    expect((await submission(second))?.dispatchState).toBe('pending')
    await exitDuringStart()
    await eventually(async () => expect((await submission(second))?.dispatchState).toBe('rejected'))
    const rows = (await host.journalSnapshot(SESSION)).items.filter((item) =>
      item.itemId.includes('start-failure')
    )
    // Both starts failed alike with nothing delivered between: one row, worded from the exit's own
    // diagnostic, as is every message it speaks for.
    expect(rows).toHaveLength(1)
    const row = rows[0].body
    expect(row).toMatchObject({ failure: { detail: { text: 'codex: config.toml is invalid' } } })
    for (const id of [first, second]) {
      expect(await submission(id)).toMatchObject({
        dispatchState: 'rejected',
        reason: row.kind === 'status' ? row.text : null,
        rejection: row.kind === 'status' ? row.failure : null
      })
    }
  })
})

describe('Stop withdraws what is queued', () => {
  it('never meets a crash leftover: the open it runs settles it first (W17a)', async () => {
    await writeAsEarlierProcess(async (journal, fence) => {
      await journal.appendSubmission({
        ...earlierSubmission('person', 'p', true),
        origin: 'client',
        source: USER_MESSAGE_SOURCE,
        fence
      })
      await journal.appendSubmission({ ...earlierSubmission('leftover', 'l', true), fence })
    })

    expect(await stop()).toMatchObject({ ok: true })

    // A person's message is kept as a held card, which no Stop withdraws; the rest is rejected.
    const hostRestarted = agentSessionFailureWords(agentSessionFailureFact('hostRestarted'), {
      surface: 'rejection'
    })
    expect(await submission('person')).toMatchObject({
      dispatchState: 'rejected',
      ...hostRestarted
    })
    expect(await submission('leftover')).toMatchObject({
      dispatchState: 'rejected',
      ...hostRestarted
    })
    const page = await host.history({ sessionId: SESSION, direction: 'tail' })
    expect(page.ok && page.page.queuedMessages?.map((card) => card.messageId)).toEqual(['person'])
    expect(acquire).toHaveBeenCalledTimes(1)
  })

  it('withdraws a message whose start holds the queue: nothing is handed over (W17b)', async () => {
    await host.close(SESSION, 'evict')
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

  it('stops a child still proving its start, rejecting what it was handed, and the next send starts another (W17c)', async () => {
    const closeSession = vi.fn(async () => true)
    adapterExtras = { closeSession }
    await host.close(SESSION, 'evict')
    await startHost()
    acquire.mockImplementationOnce(async (input) => ({
      ...(await spawnChild(input)),
      providerChildPhase: 'starting' as const
    }))
    // Written to the starting child at once; it never answers.
    dispatch.mockResolvedValueOnce({ state: 'admitted' })
    const id = await accept('hello')
    await eventually(async () => expect((await submission(id))?.handedOverAt).toBeDefined())

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })

    expect(await reopened(id)).toMatchObject({
      dispatchState: 'rejected',
      reason: DISPATCH_REJECTED_CANCELLED
    })
    expect(closeSession).toHaveBeenCalled()
    const next = await accept('after stop')
    await eventually(async () => expect((await submission(next))?.dispatchState).toBe('accepted'))
    expect(dispatch).toHaveBeenCalledTimes(2)
  })
})

describe('an eviction between acceptance and handover', () => {
  it('rejects the message as not sent, never leaves it in doubt (W24)', async () => {
    const started = deferred<void>()
    await host.close(SESSION, 'evict')
    await startHost()
    acquire.mockImplementationOnce(async (input) => {
      await started.promise
      return spawnChild(input)
    })
    const id = await accept('hello')
    await eventually(async () => expect(acquire).toHaveBeenCalledTimes(2))
    // Asked for during the delivery loop's start step, the close runs ahead of its handover step.
    const closing = host.close(SESSION, 'evict')
    started.resolve()
    await closing

    expect(await reopened(id)).toMatchObject({
      dispatchState: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('chatClosed'), { surface: 'rejection' })
    })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('rejects a queued message behind a handed-over one, which alone stays in doubt (W24)', async () => {
    await host.close(SESSION, 'evict')
    await startHost()
    dispatch.mockResolvedValueOnce({ state: 'admitted' })
    const handed = await accept('handed over')
    await eventually(async () => expect((await submission(handed))?.handedOverAt).toBeDefined())
    // Held, the second send is accepted and the close runs next, ahead of its handover.
    const second = deferred<void>()
    void host['tasks'].serialize(SESSION, () => second.promise)
    const accepting = accept('still queued')
    const closing = host.close(SESSION, 'evict')
    second.resolve()
    const queued = await accepting
    await closing

    expect(await reopened(queued)).toMatchObject({
      dispatchState: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('chatClosed'), { surface: 'rejection' })
    })
    expect(await submission(handed)).toMatchObject({ dispatchState: 'unknown' })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('does not stop an idle child while a message is still queued for it (W24)', async () => {
    idleMs = 0
    const started = deferred<void>()
    await host.close(SESSION, 'evict')
    await startHost()
    acquire.mockImplementationOnce(async (input) => {
      await started.promise
      return spawnChild(input)
    })
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

// A close abandons what is queued before it stops the child, so a wind-down step that then fails
// (reported, never the close's failure) still leaves every queued message rejected as closed,
// never blamed on the provider.
describe('a close that stops the child and then a wind-down step fails', () => {
  const END_CHILD = {
    evict: () => host.close(SESSION, 'evict')
  } satisfies Partial<Record<StructuredAgentSessionChildEndCause, () => Promise<void>>>

  it.each([
    { end: 'evict', starting: true, kind: 'chatClosed', verdict: null },
    { end: 'evict', starting: false, kind: 'chatClosed', verdict: null }
  ] as const)(
    'rejects what is queued as $kind after a $end (during startup: $starting)',
    async ({ end, starting, kind, verdict }) => {
      const started = deferred<void>()
      adapterExtras = {
        // Once: the host's own teardown acknowledges again.
        acknowledgeSessionRelease: vi.fn().mockImplementationOnce(() => {
          throw new Error('release acknowledgement failed')
        })
      }
      await host.close(SESSION, 'evict')
      await startHost()
      acquire.mockImplementationOnce(async (input) => {
        await started.promise
        return {
          ...(await spawnChild(input)),
          ...(starting ? { providerChildPhase: 'starting' as const } : {})
        }
      })
      const id = await accept('hello')
      await eventually(() => expect(acquire).toHaveBeenCalledTimes(2))

      // Asked for during the start step, the close runs ahead of the handover step.
      const ending = END_CHILD[end]()
      started.resolve()
      await expect(ending).resolves.toBeUndefined()

      await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'))
      const rejected = (await submission(id))!
      expect(rejected.rejection).toMatchObject({ kind })
      expect(classifyDispatchRejection(rejected).verdict).toBe(verdict)
      expect(dispatch).not.toHaveBeenCalled()
    }
  )
})

describe('a compaction or rewind an earlier child left prepared', () => {
  async function leftPrepared(prepare: (fence: number) => Promise<unknown>): Promise<void> {
    await host.close(SESSION, 'evict')
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
