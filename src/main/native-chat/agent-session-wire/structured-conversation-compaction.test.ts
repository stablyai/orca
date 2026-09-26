// `/compact` travels the send path: accepted as the user's message, carried out by the delivery loop
// as a turn of its own, settled by re-reading the journal. Each case reads what a subscriber that
// was open before the command saw, or the journal a client would load.

import { beforeEach, expect, it, vi, type Mock } from 'vitest'
import {
  AgentJournalSubmissionSchema,
  isAdmissibleAgentJournalItemBody
} from '../../../shared/agent-session-journal-schemas'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { structuredAgentSessionCommandTurn } from './structured-agent-session-command-turn'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import type { StructuredSessionCompactionResult } from './structured-session-compaction'

let state: ReturnType<typeof hostTestState>
let compact: Mock<NonNullable<StructuredAgentSessionAdapter['compact']>>
let abandonCommand: Mock<NonNullable<StructuredAgentSessionAdapter['abandonCommand']>>
let finish: (result: StructuredSessionCompactionResult) => void

beforeEach(() => {
  state = hostTestState()
  compact = vi.fn(
    () =>
      new Promise<StructuredSessionCompactionResult>((resolve) => {
        finish = resolve
      })
  )
  abandonCommand = vi.fn(() => finish({ outcome: 'cancellation' }))
  Object.assign(state.host.deps.adapter, { compact, abandonCommand })
})

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
  await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce())
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
  expect(facts.indexOf('status:Conversation compacted.')).toBeGreaterThan(running)
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
  await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce())
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
  await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce())
  await expect(state.host.send(CALLER, sendParams('first'))).resolves.toMatchObject({ ok: true })
  await expect(state.host.send(CALLER, sendParams('second'))).resolves.toMatchObject({ ok: true })
  // Nothing is handed over while the command's turn runs.
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(state.dispatch).not.toHaveBeenCalled()

  finish({ outcome: 'failure', error: 'Not enough messages to compact.' })

  // Delivered even though the command failed.
  await vi.waitFor(() => expect(state.dispatch).toHaveBeenCalledTimes(2))
  expect(state.dispatch.mock.calls.map(([input]) => input.body.blocks)).toEqual([
    [{ type: 'text', text: 'first' }],
    [{ type: 'text', text: 'second' }]
  ])
  const turn = await commandTurn(params.envelope.clientOperationId)
  expect(readAgentJournalTurn(turn?.body)).toMatchObject({ state: 'completed', outcome: 'failure' })
  const error = (await journal()).items.find(
    (item) => item.body.kind === 'status' && item.body.tone === 'error'
  )
  expect(error?.body).toMatchObject({ text: 'Not enough messages to compact.' })
})

it('refuses the command at handover when the provider opened a turn meanwhile (B3)', async () => {
  await attach()
  const events = state.acquire.mock.calls.at(-1)?.[0].events
  // The provider starts a turn of its own after acceptance, before the command is handed over.
  Object.assign(state.host.deps.adapter, {
    awaitStarted: vi.fn(async () => {
      events?.appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'provider-turn', ordinal: 0 },
        { kind: 'turn', turnId: 'provider-turn', state: 'running' },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true }
      )
    })
  })
  const params = compactParams()

  await expect(state.host.conversationCommand(CALLER, params)).resolves.toMatchObject({
    ok: true,
    value: {
      state: 'completed',
      error: 'Wait for the current turn to finish before using this command.'
    }
  })
  expect(compact).not.toHaveBeenCalled()
  expect(await commandTurn(params.envelope.clientOperationId)).toBeUndefined()
  expect(
    (await journal()).submissions.find(
      (entry) => entry.clientMessageId === params.envelope.clientOperationId
    )
  ).toMatchObject({ dispatchState: 'rejected' })
})

it('leaves a command whose start failed not sent, beside one start-failure row (B3)', async () => {
  await attach()
  await state.host.close(SESSION)
  state.acquire.mockRejectedValue(new Error('not signed in'))
  const params = compactParams()

  await expect(state.host.conversationCommand(CALLER, params)).resolves.toMatchObject({
    ok: true,
    value: { state: 'completed', error: expect.stringContaining('not signed in') }
  })
  const snapshot = await journal()
  expect(snapshot.items.filter((item) => readAgentJournalTurn(item.body))).toEqual([])
  expect(
    snapshot.items.filter((item) => item.body.kind === 'status' && item.body.tone === 'error')
  ).toHaveLength(1)
  expect(compact).not.toHaveBeenCalled()
})

it('ends the command at Stop before the provider opened a turn for it (B4)', async () => {
  await attach()
  const params = compactParams()
  const cmid = params.envelope.clientOperationId
  await state.host.conversationCommand(CALLER, params)
  await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce())
  const { turnId } = structuredAgentSessionCommandTurn(cmid)

  await expect(
    state.host.cancel(CALLER, {
      envelope: envelope('agentSession.cancel', { turnId }),
      turnId
    })
  ).resolves.toMatchObject({ ok: true, value: { cancelled: true } })

  expect(abandonCommand).toHaveBeenCalledWith(SESSION)
  await vi.waitFor(async () =>
    expect(readAgentJournalTurn((await commandTurn(cmid))?.body)).toMatchObject({
      state: 'interrupted',
      outcome: 'cancellation'
    })
  )
  // A cancellation writes no result row.
  expect((await journal()).items.some((item) => item.itemId.includes('command-result'))).toBe(false)
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

it('writes one exit row when the child dies mid-command, and the loop writes nothing (B4)', async () => {
  state.acquire.mockImplementation(async ({ fence, spawnToken }) => ({
    process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
    acquisitionGeneration: 'generation-1',
    link: {
      linkId: `link-${fence}`,
      handle: { provider: 'codex', threadId: THREAD },
      origin: 'created',
      mintedAtFence: fence,
      observedAt: 1
    }
  }))
  await attach()
  const params = compactParams()
  const cmid = params.envelope.clientOperationId
  await state.host.conversationCommand(CALLER, params)
  await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce())

  await state.host.handleAdapterEvent({
    type: 'ended',
    sessionId: SESSION,
    fence: state.store.getRecord(SESSION)!.lease.runtimeFence,
    acquisitionGeneration: 'generation-1',
    reason: 'provider exited',
    cause: 'unexpected-exit'
  })
  finish({ outcome: 'failure', error: 'The provider exited during compaction.' })

  await vi.waitFor(async () =>
    expect(readAgentJournalTurn((await commandTurn(cmid))?.body)?.state).toBe('interrupted')
  )
  await new Promise((resolve) => setTimeout(resolve, 50))
  const snapshot = await journal()
  expect(
    snapshot.items.filter((item) => item.body.kind === 'status' && item.body.tone === 'error')
  ).toHaveLength(1)
  expect(snapshot.items.some((item) => item.itemId.includes('command-result'))).toBe(false)
  expect(snapshot.submissions.find((entry) => entry.clientMessageId === cmid)?.dispatchState).toBe(
    'unknown'
  )
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
  await vi.waitFor(() => expect(state.dispatch).toHaveBeenCalledOnce())
  await expect(state.host.conversationCommand(CALLER, compactParams())).resolves.toMatchObject({
    ok: true,
    value: { state: 'completed' }
  })
  await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce())
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
      error: 'Compaction completion is unconfirmed; it was not run again.'
    }
  })
  expect(compact).toHaveBeenCalledOnce()
})

it('never lets a provider echo alias the command entry', async () => {
  await attach()
  const params = compactParams()
  await state.host.conversationCommand(CALLER, params)
  await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce())
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
