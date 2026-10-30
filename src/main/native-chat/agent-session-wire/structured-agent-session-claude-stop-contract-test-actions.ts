import { createStoppedClaudeDeadline } from './structured-agent-session-stop-deadline.test-fixture'
import { expect, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-live-turn'
import { projectStructuredAgentSessionStatusState } from '../../../shared/structured-agent-session-projection'
import { structuredAgentSessionAgentStatus } from '../../../shared/structured-agent-session-agent-status'
import {
  claudeFrame as frame,
  claudeWasSent as wrote,
  type FakeConnection
} from '../../claude/claude-structured-session-test-support'
import { invokeCanUseTool } from '../../claude/claude-can-use-tool-test-support'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

import {
  fixture,
  CALLER,
  CAPABILITIES,
  laneDrained
} from './structured-agent-session-claude-stop-contract-test-fixture'
export function eventually<T>(assertion: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

export function envelope(
  method: 'agentSession.send' | 'agentSession.cancel',
  fields: Record<string, unknown>,
  fence = fixture.store.getRecord(SESSION)!.lease.runtimeFence
) {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: fence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

export async function send(text: string, fence?: number): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await fixture.host.send(CALLER, {
    envelope: envelope('agentSession.send', { body }, fence),
    body
  })
  if (!sent.ok) {
    throw new Error('send refused')
  }
  return sent.value.clientMessageId
}

export async function dispatch(clientMessageId: string) {
  const submission = (await fixture.host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
  return { state: submission?.dispatchState, reason: submission?.reason }
}

export async function openTurn(
  connection: FakeConnection,
  text = 'Write a long reply.'
): Promise<string> {
  const clientMessageId = await send(text)
  await eventually(() =>
    expect(connection.sent.some((message) => JSON.stringify(message).includes(text))).toBe(true)
  )
  frame(connection, {
    type: 'system',
    subtype: 'init',
    uuid: `init-${text}`,
    model: 'claude-sonnet-5',
    capabilities: CAPABILITIES
  })
  const written = connection.sent.at(-1)!
  frame(connection, { ...written, uuid: written.uuid })
  frame(connection, {
    type: 'assistant',
    uuid: 'stopped-turn-leaf',
    parent_tool_use_id: null,
    message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'Working on' }] }
  })
  await eventually(async () => expect((await dispatch(clientMessageId)).state).toBe('accepted'))
  const turnId = activeStructuredAgentSessionTurnId(
    (await fixture.host.journalSnapshot(SESSION)).items
  )
  expect(turnId).not.toBeNull()
  return turnId!
}

export function stop(turnId?: string) {
  const fields = turnId === undefined ? {} : { turnId }
  return fixture.host.cancel(CALLER, {
    envelope: envelope('agentSession.cancel', fields),
    ...fields
  })
}

/** Drain through Stop’s queued second step. */

export function stopEventsAtClose(connection: FakeConnection): () => number | undefined {
  let atClose: number | undefined
  const close = connection.close
  connection.close = async () => {
    const journal = fixture.host.collaboratorsForTests().sessions.get(SESSION)?.journal
    atClose ??= journal?.stopMarks.latest()?.event.reason === 'user-stop' ? 1 : 0
    return close()
  }
  return () => atClose
}

export async function interruptSent(connection: FakeConnection): Promise<void> {
  await eventually(() =>
    expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(true)
  )
}

export async function turnOutcome(): Promise<string | undefined> {
  await fixture.host.flushStreamedEvents(SESSION)
  const snapshot = await fixture.host.journalSnapshot(SESSION)
  return readAgentJournalTurn(snapshot.items.findLast((item) => item.body.kind === 'turn')?.body)
    ?.outcome
}

export async function statusTexts(): Promise<string[]> {
  await fixture.host.flushStreamedEvents(SESSION)
  return (await fixture.host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'status' ? [String(item.body.text)] : []
  )
}

export async function sendUnechoed(connection: FakeConnection): Promise<string> {
  const clientMessageId = await send('Write a long reply.')
  await eventually(() => expect(wrote(connection, 'Write a long reply.')).toBe(true))
  return clientMessageId
}

export function childRecords() {
  return fixture.statusSubject
    ? fixture.server.getStructuredChildWorkViews(fixture.statusSubject)
    : []
}

export async function agentStatus() {
  await fixture.host.flushStreamedEvents(SESSION)
  const { items, submissions } = await fixture.host.journalSnapshot(SESSION)
  const { summary } = projectStructuredAgentSessionStatusState(
    items,
    submissions,
    fixture.store.getRecord(SESSION)!.lease.runtimeFence
  )
  return summary.status
    ? structuredAgentSessionAgentStatus({
        status: summary.status,
        turnOutcome: summary.turnOutcome,
        childWork: childRecords()
      })
    : null
}

export async function ask(
  connection: FakeConnection,
  toolName: string,
  input: Record<string, unknown>,
  signal?: AbortSignal
): Promise<{
  answered: ReturnType<typeof invokeCanUseTool>
  card: { itemId: string; expectedRevision: number }
}> {
  const answered = invokeCanUseTool(connection, toolName, 'permission-1', 'tool-1', {
    input,
    ...(signal ? { signal } : {})
  })
  const card = await eventually(async () => {
    await fixture.host.flushStreamedEvents(SESSION)
    const item = (await fixture.host.journalSnapshot(SESSION)).items.find(
      (entry) => entry.body.kind === 'approval' || entry.body.kind === 'question'
    )
    expect(item).toBeDefined()
    return { itemId: item!.itemId, expectedRevision: item!.revision }
  })
  return { answered, card }
}

export function cancelCard(turnId: string, prompt: { itemId: string; expectedRevision: number }) {
  const fields = { turnId, prompt }
  return fixture.host.cancel(CALLER, {
    envelope: envelope('agentSession.cancel', fields),
    ...fields
  })
}

export async function cardResolution(itemId: string): Promise<unknown> {
  await fixture.host.flushStreamedEvents(SESSION)
  const body = (await fixture.host.journalSnapshot(SESSION)).items.find(
    (item) => item.itemId === itemId
  )?.body
  return body?.kind === 'approval' || body?.kind === 'question' ? body.resolution : undefined
}

export const stopAcrossGrace = createStoppedClaudeDeadline({
  host: () => fixture.host,
  adapter: () => fixture.adapter,
  claude: () => fixture.claude,
  sessionId: SESSION,
  stop,
  laneDrained
})
