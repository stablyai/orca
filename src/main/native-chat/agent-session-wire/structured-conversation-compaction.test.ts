// `/compact` travels the send path: accepted as the user's message, carried out by the delivery loop
// as a turn of its own, settled by re-reading the journal. Each case reads what a subscriber that
// was open before the command saw, or the journal a client would load.

import { beforeEach, expect, it, vi, type Mock } from 'vitest'
import { isAdmissibleAgentJournalItemBody } from '../../../shared/agent-session-journal-schemas'
import { AgentJournalSubmissionSchema } from '../../../shared/agent-session-journal-submission-schema'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { structuredAgentSessionCommandTurn } from './structured-agent-session-command-turn'
import { settleStaleStructuredAgentSessionState } from './structured-agent-session-dead-generation-settlement'
import {
  attach,
  CALLER,
  envelope,
  hostTestState,
  replaceHostTestState
} from './structured-agent-session-host-test-harness'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { StructuredAgentRegistry } from './structured-agent-registry'
import { CODEX_STRUCTURED_AGENT } from '../../codex/codex-structured-agent-definition'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import type { StructuredConversationCommandOutcome } from './structured-conversation-command-outcome'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

let state: ReturnType<typeof hostTestState>
let compact: Mock<NonNullable<StructuredAgentSessionAdapter['compact']>>
let closeSession: Mock<NonNullable<StructuredAgentSessionAdapter['closeSession']>>

beforeEach(() => {
  state = hostTestState()
  // Codex's ack: the provider took the command, which its translator ends later.
  compact = vi.fn(async () => ({ state: 'accepted' as const, providerIdentity: null }))
  closeSession = vi.fn(async () => true)
  Object.assign(state.host.deps.adapter, { compact, closeSession })
})

/** What the child's journal translator writes when the provider ends the command: the command's
 *  one result row and its turn's end, in one batch. */
function finish(result: StructuredConversationCommandOutcome): void {
  const { command } = compact.mock.calls.at(-1)![0]
  const events = state.acquire.mock.calls.at(-1)![0].events!
  const turnScope = { kind: 'turn' as const, turnItemId: agentJournalItemKey(command.identity) }
  const row: AgentJournalItemBody | null =
    result.outcome === 'success'
      ? { kind: 'status', text: 'Context compacted', presentation: 'compaction' }
      : result.outcome === 'failure'
        ? {
            kind: 'status',
            ...agentSessionFailureWords(
              result.failure ?? agentSessionFailureFact('compactionUnconfirmed'),
              { surface: 'row' }
            ),
            tone: 'error'
          }
        : null
  events.appendLifecycleBatch!(
    `turn-completed:${command.clientMessageId}`,
    [
      ...(row
        ? [{ kind: 'item' as const, identity: command.resultIdentity, body: row, turnScope }]
        : []),
      {
        kind: 'item',
        identity: command.identity,
        body: {
          ...command.running,
          state: result.outcome === 'cancellation' ? 'interrupted' : 'completed',
          outcome: result.outcome,
          completedAt: HOST_TEST_NOW
        },
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    ],
    { lifecycle: true }
  )
}

/** Claude's words for a compaction it refused, as its frames carry them. */
const NOT_ENOUGH = { text: 'Not enough messages to compact.', audience: 'person' as const }

function compactParams() {
  return {
    command: 'compact' as const,
    envelope: envelope('agentSession.conversationCommand', { command: 'compact' })
  }
}

function sendParams(text: string) {
  const body = hostTestMessage(text)
  return { envelope: envelope('agentSession.send', { body }), body }
}

async function subscribe(): Promise<AgentSessionSubscribeEvent[]> {
  const events: AgentSessionSubscribeEvent[] = []
  await state.host.subscribe({
    id: 'pane',
    sessionId: SESSION,
    emit: (event) => events.push(event)
  })
  return events
}

/** One line per journal fact a subscriber received, in delivery order. */
function frames(events: AgentSessionSubscribeEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'batch'
      ? [
          ...event.batch.items.map(describeItem),
          ...event.batch.submissions.map(
            (entry) => `submission:${entry.dispatchState}${entry.handedOverAt ? ':handed' : ''}`
          )
        ]
      : []
  )
}

function describeItem(item: AgentJournalRenderItem): string {
  const turn = readAgentJournalTurn(item.body)
  if (turn) {
    return `turn:${turn.state}${turn.outcome ? `:${turn.outcome}` : ''}`
  }
  return item.body.kind === 'status' ? `status:${item.body.text}` : item.body.kind
}

async function journal() {
  return state.host.journalSnapshot(SESSION)
}

async function commandTurn(clientMessageId: string) {
  const { itemId } = structuredAgentSessionCommandTurn(clientMessageId)
  return (await journal()).items.find((item) => item.itemId === itemId)
}

it('answers at handover, then journals its own entry, turn and result (B1, B16)', async () => {
  await attach()
  const events = await subscribe()
  const params = compactParams()
  const cmid = params.envelope.clientOperationId

  // The reply means "started"; the provider has not finished.
  await expect(state.host.conversationCommand(CALLER, params)).resolves.toMatchObject({
    ok: true,
    value: { command: 'compact', state: 'completed' }
  })
  await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce(), { interval: 1 })
  finish({ outcome: 'success' })

  await vi.waitFor(async () =>
    expect(readAgentJournalTurn((await commandTurn(cmid))?.body)?.state).toBe('completed')
  )
  // A client saw the command working before it saw the command's end.
  const facts = frames(events)
  const running = facts.indexOf('turn:running')
  const ended = facts.indexOf('turn:completed:success')
  expect(running, facts.join('\n')).toBeGreaterThanOrEqual(0)
  expect(ended).toBeGreaterThan(running)
  expect(facts.indexOf('status:Context compacted')).toBeGreaterThan(running)
  // No turn row was ever overwritten by another body kind.
  const turnKey = structuredAgentSessionCommandTurn(cmid).itemId
  for (const event of events) {
    for (const item of event.type === 'batch' ? event.batch.items : []) {
      expect(item.itemId !== turnKey || item.body.kind === 'turn').toBe(true)
    }
  }
  const snapshot = await journal()
  const entry = snapshot.items.find((item) => item.body.kind === 'message')
  expect(entry?.body).toMatchObject({ command: { name: 'compact' } })
  expect(entry?.turnScope).toEqual(AGENT_JOURNAL_THREAD_SCOPE)
  const result = snapshot.items.find(
    (item) => item.body.kind === 'status' && item.body.presentation === 'compaction'
  )
  expect(result?.turnScope).toEqual({ kind: 'turn', turnItemId: turnKey })
  const submission = snapshot.submissions.find((item) => item.clientMessageId === cmid)
  expect(submission).toMatchObject({ dispatchState: 'accepted', providerItemId: null })
  // An older client's schemas take the accepted submission with no provider item.
  expect(AgentJournalSubmissionSchema.safeParse(submission).success).toBe(true)
  expect(isAdmissibleAgentJournalItemBody(entry!.body)).toBe(true)
  expect(state.dispatch).not.toHaveBeenCalled()
})

it('replays the reply for the same operation without running it again (B16)', async () => {
  await attach()
  const params = compactParams()
  await state.host.conversationCommand(CALLER, params)
  await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce(), { interval: 1 })
  finish({ outcome: 'success' })
  await expect(state.host.conversationCommand(CALLER, params)).resolves.toMatchObject({
    ok: true,
    replayed: true
  })
  expect(compact).toHaveBeenCalledOnce()
})

it('holds messages sent during the command and delivers them after it, in order (B2)', async () => {
  await attach()
  const params = compactParams()
  await state.host.conversationCommand(CALLER, params)
  await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce(), { interval: 1 })
  await expect(state.host.send(CALLER, sendParams('first'))).resolves.toMatchObject({ ok: true })
  await expect(state.host.send(CALLER, sendParams('second'))).resolves.toMatchObject({ ok: true })
  // Nothing is handed over while the command's turn runs.
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(state.dispatch).not.toHaveBeenCalled()

  finish({
    outcome: 'failure',
    failure: agentSessionFailureFact('compactionFailed', { detail: NOT_ENOUGH })
  })

  // Delivered even though the command failed.
  await vi.waitFor(() => expect(state.dispatch).toHaveBeenCalledTimes(2), { interval: 1 })
  expect(state.dispatch.mock.calls.map(([input]) => input.body.blocks)).toEqual([
    [{ type: 'text', text: 'first' }],
    [{ type: 'text', text: 'second' }]
  ])
  const turn = await commandTurn(params.envelope.clientOperationId)
  expect(readAgentJournalTurn(turn?.body)).toMatchObject({ state: 'completed', outcome: 'failure' })
  const error = (await journal()).items.find(
    (item) => item.body.kind === 'status' && item.body.tone === 'error'
  )
  expect(error?.body).toMatchObject({
    text: 'Compaction failed: Not enough messages to compact.',
    failure: { kind: 'compactionFailed', detail: NOT_ENOUGH }
  })
})

it('hands over a message held behind the command when the command ends just as the loop stops for it', async () => {
  await attach()
  await state.host.conversationCommand(CALLER, compactParams())
  await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce(), { interval: 1 })
  const { journal: live } = state.host['sessions'].get(SESSION)!
  const activeTurnId = live.activeTurnId
  let ended = false
  vi.spyOn(live, 'activeTurnId').mockImplementation(() => {
    const read = activeTurnId()
    // The provider's end lands the moment the loop's own step reads the command as running and
    // stops; no other reader's view of it matters here.
    if (
      !ended &&
      read?.startsWith('compact:') &&
      /at (?:StructuredAgentSessionDeliveryLoop\.)?prepare \(.*structured-agent-session-delivery-loop/.test(
        new Error('who reads').stack ?? ''
      )
    ) {
      ended = true
      finish({ outcome: 'success' })
    }
    return read
  })

  await expect(state.host.send(CALLER, sendParams('held'))).resolves.toMatchObject({ ok: true })

  await vi.waitFor(() => expect(state.dispatch).toHaveBeenCalledOnce(), { interval: 1 })
  expect(ended).toBe(true)
})

it('settles a command the provider refused as a failure with its reason, and moves on (B3)', async () => {
  await attach()
  compact.mockResolvedValue({
    state: 'rejected',
    ...agentSessionFailureWords(
      agentSessionFailureFact('providerRejected', { detail: NOT_ENOUGH }),
      {
        surface: 'rejection'
      }
    )
  })
  const params = compactParams()
  const cmid = params.envelope.clientOperationId
  await state.host.conversationCommand(CALLER, params)
  await state.host.send(CALLER, sendParams('after the refusal'))

  await vi.waitFor(() => expect(state.dispatch).toHaveBeenCalledOnce(), { interval: 1 })
  expect(readAgentJournalTurn((await commandTurn(cmid))?.body)).toMatchObject({
    state: 'completed',
    outcome: 'failure'
  })
  const snapshot = await journal()
  // The message was not sent, in the provider's words; the command's row says the compaction failed.
  expect(snapshot.submissions.find((entry) => entry.clientMessageId === cmid)).toMatchObject({
    dispatchState: 'rejected',
    reason: 'The provider did not accept this message: Not enough messages to compact.',
    rejection: { kind: 'providerRejected', detail: NOT_ENOUGH }
  })
  expect(
    snapshot.items.filter((item) => item.body.kind === 'status' && item.body.tone === 'error')
  ).toEqual([
    expect.objectContaining({
      body: {
        kind: 'status',
        text: 'Compaction failed: Not enough messages to compact.',
        failure: { kind: 'compactionFailed', detail: NOT_ENOUGH },
        tone: 'error'
      },
      turnScope: { kind: 'turn', turnItemId: structuredAgentSessionCommandTurn(cmid).itemId }
    })
  ])
})

it('says only that the compaction failed when the provider refused it without words', async () => {
  await attach()
  compact.mockResolvedValue({
    state: 'rejected',
    ...agentSessionFailureWords(agentSessionFailureFact('writeFailed'), { surface: 'rejection' })
  })
  const params = compactParams()
  await state.host.conversationCommand(CALLER, params)

  await vi.waitFor(async () =>
    expect(
      (await journal()).items
        .filter((item) => item.body.kind === 'status' && item.body.tone === 'error')
        .map((item) => item.body)
    ).toEqual([
      {
        kind: 'status',
        text: 'Compaction failed.',
        failure: { kind: 'compactionFailed' },
        tone: 'error'
      }
    ])
  )
})

it('refuses the command for an agent that does not declare compaction, whatever its adapter has', async () => {
  const declared = CODEX_STRUCTURED_AGENT.capabilities
  const agents = new StructuredAgentRegistry([
    {
      definition: {
        ...CODEX_STRUCTURED_AGENT,
        capabilities: { ...declared, compact: false, threadGoal: false, rewind: false }
      },
      adapter: state.host.deps.adapter
    }
  ])
  replaceHostTestState({
    store: state.store,
    host: new StructuredAgentSessionHost({ ...state.host.deps, agents })
  })
  state = hostTestState()
  await attach()
  const params = compactParams()

  await expect(state.host.conversationCommand(CALLER, params)).resolves.toMatchObject({
    ok: true,
    value: { state: 'completed', failure: { kind: 'commandRefused' } }
  })
  expect(compact).not.toHaveBeenCalled()
  expect(await commandTurn(params.envelope.clientOperationId)).toBeUndefined()
})

it('refuses the command at handover when the provider opened a turn meanwhile (B3)', async () => {
  await attach()
  const events = state.acquire.mock.calls.at(-1)?.[0].events
  const params = compactParams()
  // Held, the command is accepted, then the provider starts a turn of its own, both ahead of the
  // handover the acceptance asks for.
  const held = Promise.withResolvers<void>()
  void state.host['tasks'].serialize(SESSION, () => held.promise)
  const commanded = state.host.conversationCommand(CALLER, params)
  void state.host['tasks'].serialize(SESSION, async () => {
    events?.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'provider-turn', ordinal: 0 },
      { kind: 'turn', turnId: 'provider-turn', state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true }
    )
  })
  held.resolve()

  const refused = {
    kind: 'commandRefused',
    refusal: { code: 'agent_session_operation_invalid', details: { reason: 'turnActive' } }
  }
  await expect(commanded).resolves.toMatchObject({
    ok: true,
    // The reason, said as its refusal is everywhere, not a bare "try it again".
    value: {
      state: 'completed',
      error: "The agent is still working. Run /compact when it's done.",
      failure: refused
    }
  })
  expect(compact).not.toHaveBeenCalled()
  expect(await commandTurn(params.envelope.clientOperationId)).toBeUndefined()
  expect(
    (await journal()).submissions.find(
      (entry) => entry.clientMessageId === params.envelope.clientOperationId
    )
  ).toMatchObject({
    dispatchState: 'rejected',
    reason: "The agent is still working. Run /compact when it's done.",
    rejection: refused
  })
})

it('leaves a command whose start failed not sent, beside one start-failure row (B3)', async () => {
  await attach()
  await state.host.close(SESSION, 'evict')
  state.acquire.mockRejectedValue(new Error('not signed in'))
  const params = compactParams()

  // The next step is the command again, not a message.
  await expect(state.host.conversationCommand(CALLER, params)).resolves.toMatchObject({
    ok: true,
    value: {
      state: 'completed',
      error: "Codex couldn't restart. Run /compact again.",
      failure: { kind: 'restartFailed' }
    }
  })
  const snapshot = await journal()
  expect(snapshot.items.filter((item) => readAgentJournalTurn(item.body))).toEqual([])
  // The start's own row, in the words the command's message was refused with.
  expect(
    snapshot.items
      .filter((item) => item.body.kind === 'status' && item.body.tone === 'error')
      .map((item) => item.body)
  ).toEqual([
    {
      kind: 'status',
      text: "Codex couldn't restart. Run /compact again.",
      failure: expect.objectContaining({ kind: 'restartFailed' }),
      tone: 'error'
    }
  ])
  expect(
    snapshot.submissions.find(
      (entry) => entry.clientMessageId === params.envelope.clientOperationId
    )
  ).toMatchObject({
    dispatchState: 'rejected',
    reason: "Codex couldn't restart. Run /compact again."
  })
  expect(compact).not.toHaveBeenCalled()
})

function stop(turnId: string) {
  return state.host.cancel(CALLER, {
    envelope: envelope('agentSession.cancel', { turnId }),
    turnId
  })
}

it('leaves the command to the provider when it takes the Stop, and ends it as cancelled (B4)', async () => {
  await attach()
  const params = compactParams()
  const cmid = params.envelope.clientOperationId
  await state.host.conversationCommand(CALLER, params)
  await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce(), { interval: 1 })
  const { turnId } = structuredAgentSessionCommandTurn(cmid)

  await expect(stop(turnId)).resolves.toMatchObject({ ok: true, value: { cancelled: true } })

  // The interrupt was taken, not answered: the command runs until the provider ends it.
  expect(state.cancelTurn).toHaveBeenCalledWith(expect.objectContaining({ turnId }))
  expect(closeSession).not.toHaveBeenCalled()
  expect(readAgentJournalTurn((await commandTurn(cmid))?.body)?.state).toBe('running')
  finish({ outcome: 'cancellation' })
  await vi.waitFor(async () =>
    expect(readAgentJournalTurn((await commandTurn(cmid))?.body)).toMatchObject({
      state: 'interrupted',
      outcome: 'cancellation'
    })
  )
  // A cancellation writes no result row.
  expect((await journal()).items.some((item) => item.itemId.includes('command-result'))).toBe(false)
})

it('ends the command by stopping the child at a second Stop the provider never answered (B4)', async () => {
  await attach()
  const statuses: AgentSessionStatusEvent[] = []
  state.host.subscribeStatus({ id: 'list', emit: (event) => statuses.push(event) })
  const params = compactParams()
  const cmid = params.envelope.clientOperationId
  await state.host.conversationCommand(CALLER, params)
  await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce(), { interval: 1 })
  const { turnId } = structuredAgentSessionCommandTurn(cmid)

  // The provider takes the interrupt and then never answers it.
  await expect(stop(turnId)).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  expect(closeSession).not.toHaveBeenCalled()
  // The chat reads Stopping, yet only the next Stop ends the command: clients keep Stop enabled.
  expect(latestSummary(statuses)).toMatchObject({ status: 'working', stopping: true })
  await expect(stop(turnId)).resolves.toMatchObject({ ok: true, value: { cancelled: true } })

  expect(state.cancelTurn).toHaveBeenCalledOnce()
  expect(closeSession).toHaveBeenCalledOnce()
  expect(readAgentJournalTurn((await commandTurn(cmid))?.body)?.state).toBe('interrupted')
  expect(latestSummary(statuses)).not.toHaveProperty('stopping')
})

/** The session's newest summary in what a session list received. */
function latestSummary(events: AgentSessionStatusEvent[]): AgentSessionStatusSummary | undefined {
  return events
    .flatMap((event) =>
      event.type === 'status' ? [event.session] : event.type === 'snapshot' ? event.sessions : []
    )
    .findLast((summary) => summary.sessionId === SESSION)
}

it('ends the command by stopping the child when the provider cannot take the Stop (B4)', async () => {
  await attach()
  // Codex before it opened the command's turn, or Claude refusing the interrupt.
  state.cancelTurn.mockResolvedValue({ cancelled: false })
  const params = compactParams()
  const cmid = params.envelope.clientOperationId
  await state.host.conversationCommand(CALLER, params)
  await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce(), { interval: 1 })

  await expect(stop(structuredAgentSessionCommandTurn(cmid).turnId)).resolves.toMatchObject({
    ok: true,
    value: { cancelled: true }
  })

  expect(closeSession).toHaveBeenCalledOnce()
  expect(readAgentJournalTurn((await commandTurn(cmid))?.body)?.state).toBe('interrupted')
  const notes = (await journal()).items.filter((item) => item.body.kind === 'status')
  expect(notes.map((item) => item.body.kind === 'status' && item.body.text)).toEqual([
    'Cancellation requested.'
  ])
  // The next message starts a child of its own.
  await state.host.send(CALLER, sendParams('after the stop'))
  await vi.waitFor(() => expect(state.dispatch).toHaveBeenCalledOnce(), { interval: 1 })
  expect(state.acquire).toHaveBeenCalledTimes(2)
})

it('does not stop the child for a Stop naming a command that already ended (B4)', async () => {
  await attach()
  state.cancelTurn.mockResolvedValue({ cancelled: false })
  const params = compactParams()
  await state.host.conversationCommand(CALLER, params)
  await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce(), { interval: 1 })
  finish({ outcome: 'success' })
  const { itemId, turnId } = structuredAgentSessionCommandTurn(params.envelope.clientOperationId)
  await vi.waitFor(async () =>
    expect(
      readAgentJournalTurn((await journal()).items.find((item) => item.itemId === itemId)?.body)
        ?.state
    ).toBe('completed')
  )

  await expect(stop(turnId)).resolves.toMatchObject({ ok: true, value: { cancelled: false } })
  expect(closeSession).not.toHaveBeenCalled()
})

it("answers a refused command's message before ending its turn, so a crash between them leaves a turn the sweep settles (B4)", async () => {
  await attach()
  // The one command end the host still writes: the provider refused it. A provider's own end is
  // one batch its translator writes, with nothing to split.
  compact.mockResolvedValue({
    state: 'rejected',
    ...agentSessionFailureWords(
      agentSessionFailureFact('providerRejected', { detail: NOT_ENOUGH }),
      {
        surface: 'rejection'
      }
    )
  })
  const { journal: live } = state.host['sessions'].get(SESSION)!
  const appendLifecycleBatch = live.appendLifecycleBatch.bind(live)
  const crash = vi
    .spyOn(live, 'appendLifecycleBatch')
    .mockImplementation((input) =>
      input.settlementId.startsWith('command-settled:')
        ? Promise.reject(new Error('host crashed'))
        : appendLifecycleBatch(input)
    )
  const params = compactParams()
  const cmid = params.envelope.clientOperationId
  await state.host.conversationCommand(CALLER, params)
  await vi.waitFor(() => expect(crash).toHaveBeenCalled(), { interval: 1 })
  crash.mockRestore()

  // Never an ended turn whose message still reads as in flight.
  expect(readAgentJournalTurn((await commandTurn(cmid))?.body)?.state).toBe('running')
  expect(
    (await journal()).submissions.find((entry) => entry.clientMessageId === cmid)?.dispatchState
  ).toBe('rejected')
  await settleStaleStructuredAgentSessionState({
    journal: live,
    sessionId: SESSION,
    fence: state.store.getRecord(SESSION)!.lease.runtimeFence,
    acquisitionGeneration: null,
    deathEvidence: null
  })
  expect(readAgentJournalTurn((await commandTurn(cmid))?.body)?.state).toBe('unverifiable')
})

it('counts a message held behind the command from its handover, not its send', async () => {
  await attach()
  await state.host.conversationCommand(CALLER, compactParams())
  await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce(), { interval: 1 })
  const sent = await state.host.send(CALLER, sendParams('held'))
  expect(sent.ok).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 20))
  finish({ outcome: 'success' })

  await vi.waitFor(() => expect(state.dispatch).toHaveBeenCalledOnce(), { interval: 1 })
  const [dispatched] = state.dispatch.mock.calls[0]!
  const submission = (await journal()).submissions.find(
    (entry) => entry.clientMessageId === dispatched.clientMessageId
  )
  expect(submission?.handedOverAt).toBeGreaterThan(submission!.submittedAt)
  expect(dispatched.requestedAt).toBe(submission?.handedOverAt)
})

it('settles a command whose adapter call threw after the start as unknown (B4)', async () => {
  await attach()
  compact.mockImplementation(() => {
    throw new Error('codex app-server session is not live')
  })
  const params = compactParams()
  const cmid = params.envelope.clientOperationId

  await expect(state.host.conversationCommand(CALLER, params)).resolves.toMatchObject({ ok: true })

  await vi.waitFor(async () =>
    expect(readAgentJournalTurn((await commandTurn(cmid))?.body)?.state).toBe('unverifiable')
  )
  expect(
    (await journal()).submissions.find((entry) => entry.clientMessageId === cmid)
  ).toMatchObject({ dispatchState: 'unknown', reason: 'codex app-server session is not live' })
})

it('writes one exit row when the child dies mid-command, and the loop writes nothing but moves on (B4)', async () => {
  state.acquire.mockImplementation(async ({ fence, spawnToken }) => ({
    process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
    acquisitionGeneration: `generation-${fence}`,
    link: {
      linkId: `link-${fence}`,
      handle: codexProviderHandle(THREAD),
      // The next child resumes the thread, as a real one does.
      origin: state.store.getRecord(SESSION)?.providerHandleChain.length ? 'resumed' : 'created',
      mintedAtFence: fence,
      observedAt: 1
    }
  }))
  await attach()
  const params = compactParams()
  const cmid = params.envelope.clientOperationId
  await state.host.conversationCommand(CALLER, params)
  await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce(), { interval: 1 })
  await expect(state.host.send(CALLER, sendParams('queued behind it'))).resolves.toMatchObject({
    ok: true
  })

  // The adapter never answers the command: the host's own record of the child's end is enough.
  const fence = state.store.getRecord(SESSION)!.lease.runtimeFence
  await state.host.handleAdapterEvent({
    type: 'ended',
    sessionId: SESSION,
    fence,
    acquisitionGeneration: `generation-${fence}`,
    reason: 'provider exited',
    cause: 'unexpected-exit'
  })

  await vi.waitFor(async () =>
    expect(readAgentJournalTurn((await commandTurn(cmid))?.body)?.state).toBe('interrupted')
  )
  // Released from the command, the loop starts a child and delivers what waited behind it.
  await vi.waitFor(() => expect(state.dispatch).toHaveBeenCalledOnce(), { interval: 1 })
  expect(state.acquire).toHaveBeenCalledTimes(2)
  const snapshot = await journal()
  expect(
    snapshot.items.filter((item) => item.body.kind === 'status' && item.body.tone === 'error')
  ).toHaveLength(1)
  expect(snapshot.items.some((item) => item.itemId.includes('command-result'))).toBe(false)
  // Codex acknowledged the command, so the message was delivered; only its turn was cut short.
  expect(snapshot.submissions.find((entry) => entry.clientMessageId === cmid)?.dispatchState).toBe(
    'accepted'
  )
})

it('delivers the next message after a command whose child died and whose settlement could not be written', async () => {
  state.acquire.mockImplementation(async ({ fence, spawnToken }) => ({
    process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
    acquisitionGeneration: `generation-${fence}`,
    link: {
      linkId: `link-${fence}`,
      handle: codexProviderHandle(THREAD),
      origin: state.store.getRecord(SESSION)?.providerHandleChain.length ? 'resumed' : 'created',
      mintedAtFence: fence,
      observedAt: 1
    }
  }))
  await attach()
  const params = compactParams()
  const cmid = params.envelope.clientOperationId
  await state.host.conversationCommand(CALLER, params)
  await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce(), { interval: 1 })
  const { journal: live } = state.host['sessions'].get(SESSION)!
  const appendLifecycleBatch = live.appendLifecycleBatch.bind(live)
  vi.spyOn(live, 'appendLifecycleBatch').mockImplementation((input) =>
    input.settlementId.includes('provider-exit:')
      ? Promise.reject(new Error('disk full'))
      : appendLifecycleBatch(input)
  )

  const fence = state.store.getRecord(SESSION)!.lease.runtimeFence
  await state.host.handleAdapterEvent({
    type: 'ended',
    sessionId: SESSION,
    fence,
    acquisitionGeneration: `generation-${fence}`,
    reason: 'provider exited',
    cause: 'unexpected-exit'
  })
  await vi.waitFor(() => expect(state.host['sessions'].get(SESSION)?.child).toBeNull())
  // The exit it recorded settles what the failed write left running, so the command holds nothing.
  await vi.waitFor(async () =>
    expect(readAgentJournalTurn((await commandTurn(cmid))?.body)?.state).toBe('interrupted')
  )

  await expect(state.host.send(CALLER, sendParams('after it'))).resolves.toMatchObject({
    ok: true
  })
  await vi.waitFor(() => expect(state.dispatch).toHaveBeenCalledOnce(), { interval: 1 })
  expect(state.acquire).toHaveBeenCalledTimes(2)
  expect(readAgentJournalTurn((await commandTurn(cmid))?.body)?.state).not.toBe('running')
})

it("ignores an older build's unconfirmed compaction record, and answers its operation without rerunning it (B15)", async () => {
  await attach()
  const older = compactParams()
  // An older build admitted this operation and died before recording its outcome.
  await state.store.admitMutationOperation({
    callerKey: CALLER.callerKey,
    envelope: older.envelope,
    hostFingerprint: older.envelope.payloadFingerprint,
    now: HOST_TEST_NOW
  })
  await state.store.setConversationCommand(
    SESSION,
    state.store.getRecord(SESSION)!.lease.runtimeFence,
    {
      command: 'compact',
      runtimeFence: state.store.getRecord(SESSION)!.lease.runtimeFence,
      operationId: older.envelope.clientOperationId,
      callerKey: CALLER.callerKey,
      phase: 'prepared',
      state: 'unknown'
    }
  )

  await expect(state.host.send(CALLER, sendParams('still works'))).resolves.toMatchObject({
    ok: true
  })
  await vi.waitFor(() => expect(state.dispatch).toHaveBeenCalledOnce(), { interval: 1 })
  await expect(state.host.conversationCommand(CALLER, compactParams())).resolves.toMatchObject({
    ok: true,
    value: { state: 'completed' }
  })
  await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce(), { interval: 1 })
  finish({ outcome: 'success' })
  await vi.waitFor(async () =>
    expect((await journal()).submissions.every((entry) => entry.dispatchState === 'accepted')).toBe(
      true
    )
  )

  await expect(state.host.conversationCommand(CALLER, older)).resolves.toMatchObject({
    ok: true,
    value: {
      state: 'unknown',
      error: 'Compaction completion is unconfirmed.',
      failure: { kind: 'compactionUnconfirmed' }
    }
  })
  expect(compact).toHaveBeenCalledOnce()
})

it('never lets a provider echo alias the command entry', async () => {
  await attach()
  const params = compactParams()
  await state.host.conversationCommand(CALLER, params)
  await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce(), { interval: 1 })
  finish({ outcome: 'success' })
  const events = state.acquire.mock.calls.at(-1)?.[0].events
  const echo = { provider: 'codex' as const, threadId: THREAD, turnId: 'later', ordinal: 0 }
  events?.appendItem(
    echo,
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: '/compact' }] },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await state.host.flushStreamedEvents(SESSION)
  expect((await journal()).items.some((item) => item.itemId === agentJournalItemKey(echo))).toBe(
    true
  )
})

it('refuses a /compact pressed again under a new id while one runs, and runs one pressed after it ended', async () => {
  await attach()
  await state.host.conversationCommand(CALLER, compactParams())
  await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce(), { interval: 1 })

  expect(await state.host.conversationCommand(CALLER, compactParams())).toMatchObject({
    ok: false,
    refusal: { details: { reason: 'turnActive' } }
  })
  expect(compact).toHaveBeenCalledOnce()

  finish({ outcome: 'success' })
  await vi.waitFor(async () =>
    expect(await state.host.conversationCommand(CALLER, compactParams())).toMatchObject({
      ok: true
    })
  )
  await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(2), { interval: 1 })
})
