import { expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import recovery from '../../__fixtures__/claude-plugin-recovery.json'
import { claudeTaskNotificationWake } from '../journal/claude-internal-message-content'
import { readClaudeMessageEnvelope } from '../journal/claude-structured-item-translation'
import { ClaudeOpenTurn } from './claude-open-turn'

// Claude resumes on its own when a background task finishes: the notification that wakes it names
// the task, and the turn it opens records that name, so Orca can tell whose task woke the chat.

/** The captured notification as the stream delivers it (stream frames carry `session_id`). */
const frames: Record<string, unknown>[] = recovery
const captured = frames[0]!
const reply = frames[1]!
const notification: Record<string, unknown> = {
  ...captured,
  session_id: captured.sessionId,
  parent_tool_use_id: null
}
const assistant: Record<string, unknown> = {
  ...reply,
  session_id: reply.sessionId,
  parent_tool_use_id: null
}

function openTurn() {
  const rows: AgentJournalItemBody[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: opening and ending a turn writes only through these members.
  const sink = {
    appendItem: (_identity: unknown, body: AgentJournalItemBody) => rows.push(body),
    publish: () => {},
    setActivity: () => {},
    setPromptSuggestion: () => {}
  } as Partial<StructuredAgentSessionEventSink> as StructuredAgentSessionEventSink
  const turn = new ClaudeOpenTurn({ sink, turnSuperseded: () => {}, endOpenWork: () => {} })
  const source = {
    sessionId: String(assistant.session_id),
    uuid: String(assistant.uuid),
    assistant: true
  }
  return { turn, rows, open: (at: number) => turn.ensureOpen(assistant, source, at) }
}

it('names the task whose notification opened a self-started turn on its row', () => {
  const envelope = readClaudeMessageEnvelope(notification)!
  const taskId = claudeTaskNotificationWake(notification, envelope)
  expect(taskId).toBe('bobbnxies')

  const { turn, rows, open } = openTurn()
  turn.wakes.observe(taskId!, turn.isOpen)
  open(100)
  expect(rows.at(-1)).toMatchObject({ kind: 'turn', state: 'running', wokenBy: ['bobbnxies'] })
})

it('names nothing on a turn a send opened, and nothing a notification into a running turn named', () => {
  const { turn, rows, open } = openTurn()
  turn.observeStartedSend({ clientMessageId: 'c1', requestedAt: 99 })
  turn.wakes.observe('bobbnxies', turn.isOpen)
  open(100)
  turn.wakes.observe('later-task', turn.isOpen)
  expect(rows.every((row) => !('wokenBy' in row))).toBe(true)
})
