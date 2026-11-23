import { expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import capture from '../../__fixtures__/claude-subagent-permission-frames.json'
import { createClaudeJournalTranslator } from '../journal/claude-structured-journal-translation'

// Claude resumes on its own when a background task finishes. In the SDK's own order the system
// task_notification frame (naming the finished run by the call that started it) arrives between turns
// and opens that turn; the turn records the run, so Orca can tell whose work woke the chat.

// The run: the Agent call that started the background subagent.
const RUN = 'toolu_0113cofGsD2kJXoxmbapdZbE'
const SESSION = 'capture-bg-allow'
const frames = capture.scenarios['bg-allow'].flatMap((entry): Record<string, unknown>[] =>
  entry.from === 'cli' ? [entry.frame] : []
)

function replay(insertAfter?: { index: number; frame: Record<string, unknown> }) {
  const turns: Extract<AgentJournalItemBody, { kind: 'turn' }>[] = []
  const record = (body: AgentJournalItemBody) => {
    if (body.kind === 'turn') {
      turns.push(body)
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the replay reads turn rows only; other writes are accepted and dropped.
  const sink = {
    appendItem: (_identity, body) => record(body),
    tryAppendItem: (_identity, body) => {
      record(body)
      return { accepted: true }
    },
    appendTombstone: () => {},
    publish: () => {},
    setActivity: () => {},
    setPromptSuggestion: () => {}
  } as Partial<StructuredAgentSessionEventSink> as StructuredAgentSessionEventSink
  const translator = createClaudeJournalTranslator({ sink })
  const send = (message: Record<string, unknown>, at: number, opens = false) =>
    translator.handle({
      type: 'message',
      sessionId: SESSION,
      message,
      observedAt: at,
      ...(opens ? { startsTurn: true, clientMessageId: 'c1', requestedAt: at } : {})
    })
  frames.forEach((frame, index) => {
    send(frame, index + 1, index === 1)
    if (insertAfter?.index === index) {
      send(insertAfter.frame, index + 1)
    }
  })
  return turns
}

it('names the task whose notification opened the turn, in the SDK frame order', () => {
  const turns = replay()
  expect(turns.filter((row) => row.wokenBy)).not.toHaveLength(0)
  expect(turns.at(-1)).toMatchObject({ wokenBy: [RUN] })
  expect(turns.filter((row) => !row.wokenBy).length).toBeGreaterThan(0)
})

it('names a task that finishes into the wake-up too', () => {
  const other = {
    ...frames[17],
    task_id: 'private-job',
    tool_use_id: 'toolu_private',
    uuid: 'other-notification'
  }
  const turns = replay({ index: 18, frame: other })
  expect(turns.at(-1)).toMatchObject({ wokenBy: [RUN, 'toolu_private'] })
})
