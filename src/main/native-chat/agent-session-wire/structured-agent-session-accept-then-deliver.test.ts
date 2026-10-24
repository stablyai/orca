import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
// Exercise durable acceptance before provider delivery through the real host/store/journal.

import type { AgentSessionFailureFact } from '../../../shared/agent-session-failure'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
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
  hostTestDrawnRowIds,
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
import { structuredAgentSessionHeldStarts } from './structured-agent-session-held-start.test-support'

const CALLER = { callerKey: 'client-1' }

const childPhase = () => host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase

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
let clock: number

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

const starts = structuredAgentSessionHeldStarts(() => host)

const spawnStartingChild = starts.held(spawnChild)

async function startHost(): Promise<void> {
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: starts.wrap({
      acquire,
      dispatch,
      closeSession: vi.fn(async () => true),
      releaseAcquisition: vi.fn(async () => true),
      cancelTurn: vi.fn(async () => ({ cancelled: false })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined),
      ...adapterExtras,
      open:
        adapterExtras.open ??
        (async () => ({
          reportedOptions: { model: '' }
        }))
    }),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${acquire.mock.calls.length}`,
    idleSweep: { intervalMs: 5, idleMs },
    now: () => clock
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-accept-deliver-'))
  resetHostTestOperationIds()
  adapterExtras = {}
  starts.clear()
  idleMs = 60 * 60_000
  clock = NOW
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

async function reopened(id: string): Promise<AgentJournalSubmission | undefined> {
  await host.revealSession(SESSION)
  return submission(id)
}

async function errorRows(): Promise<string[]> {
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'status' && item.body.tone === 'error' ? [item.body.text] : []
  )
}

async function errorFailures(): Promise<(AgentSessionFailureFact | undefined)[]> {
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'status' && item.body.tone === 'error' ? [item.body.failure] : []
  )
}

let subscriptions = 0

async function subscribe(): Promise<AgentSessionSubscribeEvent[]> {
  const events: AgentSessionSubscribeEvent[] = []
  subscriptions += 1
  // Clone at delivery: later journal revisions can change shared frame objects.
  await host.subscribe({
    id: `sub-${subscriptions}`,
    sessionId: SESSION,
    emit: (event) => events.push(structuredClone(event))
  })
  return events
}

function framedStates(events: AgentSessionSubscribeEvent[], id: string): string[] {
  let previous: string | undefined
  return events.flatMap((event) =>
    event.type === 'batch'
      ? event.batch.submissions
          .filter((entry) => entry.clientMessageId === id)
          .map((entry) =>
            entry.dispatchState === 'pending' && entry.handedOverAt !== undefined
              ? 'handed-over'
              : entry.dispatchState
          )
          .filter((state) => {
            const key = JSON.stringify([event.batch.cursor, state])
            const changed = key !== previous
            previous = key
            return changed
          })
      : []
  )
}

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
    const starting = Promise.withResolvers<void>()
    acquire.mockImplementationOnce(async (input) => {
      await starting.promise
      return spawnChild(input)
    })

    const answering = Promise.withResolvers<void>()
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
    const starting = Promise.withResolvers<void>()
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

  it('writes one error row and rejects every queued message with it; the next send starts (W3)', async () => {
    await host.close(SESSION, 'evict')
    acquire.mockRejectedValueOnce(new Error('spawn codex ENOENT'))
    const first = await accept('first')
    const second = await accept('second')

    await eventually(async () => expect((await submission(second))?.dispatchState).toBe('rejected'))
    const rows = await errorRows()
    expect(rows).toHaveLength(1)
    // Log Orca’s spawn error; absent observed exit must not blame the provider.
    expect(rows[0]).toBe("Codex couldn't restart. Send your message to try again.")
    const failure = {
      kind: 'restartFailed',
      refusal: { code: 'agent_session_operation_invalid', details: { ownerVerdict: 'exited' } }
    }
    expect(await errorFailures()).toEqual([failure])
    for (const id of [first, second]) {
      expect(await submission(id)).toMatchObject({
        dispatchState: 'rejected',
        reason: rows[0],
        rejection: failure
      })
    }

    const next = await accept('after the fix')
    await eventually(async () => expect((await submission(next))?.dispatchState).toBe('accepted'))
    expect(await errorRows()).toHaveLength(1)
  })

  it('draws the messages it failed above the error row, since they were accepted first', async () => {
    await host.close(SESSION, 'evict')
    acquire.mockRejectedValueOnce(new Error('spawn codex ENOENT'))
    const first = await accept('first')
    const second = await accept('second')
    await eventually(async () => expect((await submission(second))?.dispatchState).toBe('rejected'))

    const snapshot = await host.journalSnapshot(SESSION)
    const errorRow = snapshot.items.find(
      (item) => item.body.kind === 'status' && item.body.tone === 'error'
    )?.itemId
    const shown = [agentJournalSubmissionKey(first), agentJournalSubmissionKey(second), errorRow]
    const drawn = hostTestDrawnRowIds(snapshot, [
      { clientMessageId: first, text: 'first' },
      { clientMessageId: second, text: 'second' }
    ])
    expect(drawn.filter((id) => shown.includes(id))).toEqual(shown)
  })

  it('notifies failed once for the queued messages one start failure refused', async () => {
    await host.close(SESSION, 'evict')
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
        text: "Codex couldn't restart. Send your message to try again.",
        failure: {
          kind: 'restartFailed',
          refusal: { code: 'agent_session_operation_invalid', details: { ownerVerdict: 'exited' } }
        }
      }
    ]
  ])('writes one row a live chat sees for a %s refusal (W14)', async (_source, arrange, row) => {
    await host.close(SESSION, 'evict')
    arrange()
    await host.flushAllStreamedEvents()
    await startHost()
    const id = await accept('hello')
    const events = await subscribe()

    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'))
    expect(await errorRows()).toEqual([row.text])
    expect(await errorFailures()).toEqual([row.failure])
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
    await host.close(SESSION, 'evict')
    const id = await accept('hello')
    // Fail the post-acquisition success record.
    const record = vi.spyOn(store, 'recordOperationOutcome')
    record.mockImplementation(async (input) => {
      if (input.operationId !== id && input.outcome.status === 'succeeded') {
        record.mockRestore()
        throw new Error('record store write failed')
      }
      return AgentSessionRecordStore.prototype.recordOperationOutcome.call(store, input)
    })

    // Reopen through the normal path so recovery settles dropped conversations.
    let settled: AgentJournalSubmission | undefined
    await eventually(async () => {
      settled = await reopened(id)
      expect(settled?.dispatchState).not.toBe('pending')
    })
    // Attribute rejection to the failed start, keeping host storage errors in logs.
    expect(settled).toMatchObject({
      dispatchState: 'rejected',
      rejection: (await errorFailures())[0]
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
    // Fail outcome recording after onAttached has indexed the child.
    const record = vi.spyOn(store, 'recordOperationOutcome')
    record.mockImplementation(async (input) => {
      if (input.operationId !== first && input.outcome.status === 'succeeded') {
        record.mockRestore()
        throw new Error('record store write failed')
      }
      return AgentSessionRecordStore.prototype.recordOperationOutcome.call(store, input)
    })
    await eventually(async () => expect((await submission(first))?.dispatchState).toBe('rejected'))
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
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('a child that exits before open completes', () => {
  it('rejects the message with the start failure instead of starting another child (W24)', async () => {
    await host.close(SESSION, 'evict')
    await startHost()
    acquire.mockImplementation(async (input) => {
      const child = await spawnStartingChild(input)
      const acquisitionGeneration = `generation-${acquire.mock.calls.length}`
      void starts.prove({ sessionId: SESSION, fence: input.fence, acquisitionGeneration })
      void host.handleAdapterEvent({
        type: 'ended',
        sessionId: SESSION,
        fence: input.fence,
        acquisitionGeneration,
        reason: 'codex app-server crashed',
        cause: 'unexpected-exit'
      })
      return child
    })

    const id = await accept('hello')

    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'))
    expect(await submission(id)).toMatchObject({
      reason: 'Codex stopped before it finished starting. Send your message to try again.',
      rejection: { kind: 'providerStartFailed' }
    })
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('a start that fails while messages wait on it', () => {
  it('keeps one row in the words its rejected messages carry', async () => {
    acquire.mockImplementation(spawnStartingChild)
    await host.close(SESSION, 'evict')
    await startHost()

    const first = await accept('first')
    const second = await accept('second')
    await eventually(() => expect(childPhase()).toBe('starting'))
    await host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      fence: store.getRecord(SESSION)!.lease.runtimeFence,
      acquisitionGeneration: `generation-${acquire.mock.calls.length}`,
      reason: 'codex app-server exited with code 1',
      failure: agentSessionFailureFact('providerStartFailed', {
        detail: { text: 'codex: config.toml is invalid', audience: 'person' }
      }),
      cause: 'unexpected-exit'
    })
    await host.flushStreamedEvents(SESSION)

    await eventually(async () => expect((await submission(second))?.dispatchState).toBe('rejected'))
    const rows = (await host.journalSnapshot(SESSION)).items.filter((item) =>
      item.itemId.includes('start-failure')
    )
    expect(rows).toHaveLength(1)
    const row = rows[0].body
    expect(row).toMatchObject({
      failure: { kind: 'providerStartFailed', detail: { text: 'codex: config.toml is invalid' } }
    })
    for (const id of [first, second]) {
      expect(await submission(id)).toMatchObject({
        dispatchState: 'rejected',
        reason: row.kind === 'status' ? row.text : null,
        rejection: row.kind === 'status' ? row.failure : null
      })
    }
    expect(dispatch).not.toHaveBeenCalled()
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

    // Personal text survives as a card under reopen pause; reject nonpersonal work.
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

  it('stops a child still proving its start, withdrawing what was held for it, and the next send starts another (W17c)', async () => {
    const closeSession = vi.fn(async () => true)
    adapterExtras = { closeSession }
    await host.close(SESSION, 'evict')
    await startHost()
    acquire.mockImplementationOnce(spawnStartingChild)
    const id = await accept('hello')
    await eventually(() => expect(childPhase()).toBe('starting'))
    expect((await submission(id))?.handedOverAt).toBeUndefined()

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })

    expect(await reopened(id)).toMatchObject({
      dispatchState: 'rejected',
      reason: DISPATCH_REJECTED_CANCELLED
    })
    expect(closeSession).toHaveBeenCalled()
    const next = await accept('after stop')
    await eventually(async () => expect((await submission(next))?.dispatchState).toBe('accepted'))
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
})

describe('an eviction between acceptance and handover', () => {
  it('rejects the message as not sent, never leaves it in doubt (W24)', async () => {
    const started = Promise.withResolvers<void>()
    await host.close(SESSION, 'evict')
    await startHost()
    acquire.mockImplementationOnce(async (input) => {
      await started.promise
      return spawnChild(input)
    })
    const id = await accept('hello')
    await eventually(async () => expect(acquire).toHaveBeenCalledTimes(2))
    // Queue close ahead of the delivery loop’s handover step.
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
    // Hold delivery so close queues after acceptance but before handover.
    const second = Promise.withResolvers<void>()
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
    idleMs = 1_000
    const started = Promise.withResolvers<void>()
    await host.close(SESSION, 'evict')
    await startHost()
    acquire.mockImplementationOnce(async (input) => {
      await started.promise
      return spawnChild(input)
    })
    const id = await accept('hello')
    await eventually(async () => expect(acquire).toHaveBeenCalledTimes(2))
    clock = NOW + idleMs
    await new Promise((resolve) => setTimeout(resolve, 20))

    // Refresh time before readiness; intentionally silent starts remain evictable.
    clock = NOW
    started.resolve()
    await eventually(async () => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(dispatch.mock.calls[0]?.[0].clientMessageId).toBe(id)
    expect(acquire).toHaveBeenCalledTimes(2)
  })
})

// Wind-down errors must not undo closed-send settlement or attribute host faults to the provider.
describe('a close that stops the child and then a wind-down step fails', () => {
  const END_CHILD = {
    evict: () => host.close(SESSION, 'evict')
  } satisfies Partial<Record<StructuredAgentSessionChildEndCause, () => Promise<void>>>

  it.each([{ end: 'evict', starting: true, kind: 'chatClosed', verdict: null }] as const)(
    'rejects what is queued as $kind after a $end (during startup: $starting)',
    async ({ end, starting, kind, verdict }) => {
      adapterExtras = {
        // Teardown acknowledges again; fail only the first call.
        acknowledgeSessionRelease: vi.fn().mockImplementationOnce(() => {
          throw new Error('release acknowledgement failed')
        })
      }
      await host.close(SESSION, 'evict')
      await startHost()
      acquire.mockImplementationOnce(starting ? spawnStartingChild : spawnChild)
      const id = await accept('hello')
      await eventually(() => expect(childPhase()).toBe('starting'))

      await expect(END_CHILD[end]()).resolves.toBeUndefined()

      await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'))
      const rejected = (await submission(id))!
      expect(rejected.rejection).toMatchObject({ kind })
      expect(classifyDispatchRejection(rejected).verdict).toBe(verdict)
      expect(dispatch).not.toHaveBeenCalled()
    }
  )
})

describe('a rewind an earlier child left prepared', () => {
  async function leftPrepared(prepare: (fence: number) => Promise<unknown>): Promise<void> {
    await host.close(SESSION, 'evict')
    await prepare(store.getRecord(SESSION)!.lease.runtimeFence)
    await host.flushAllStreamedEvents()
    await startHost()
  }

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
