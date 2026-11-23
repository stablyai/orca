import { expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import capture from '../../__fixtures__/claude-subagent-permission-frames.json'
import { createClaudeJournalTranslator } from '../journal/claude-structured-journal-translation'
import { resolveAgentJournalTurnRowWrite } from '../../../native-chat/agent-session-timeline/agent-journal-turn-row-revision'

// Claude resumes on its own when a background task finishes. In the SDK's own order the system
// task_notification frame (naming the finished run by the call that started it) arrives between turns
// and opens that turn; the turn records the run, so Orca can tell whose work woke the chat.

// The run: the Agent call that started the background subagent.
const RUN = 'toolu_0113cofGsD2kJXoxmbapdZbE'
const SESSION = 'capture-bg-allow'
const frames = capture.scenarios['bg-allow'].flatMap((entry): Record<string, unknown>[] =>
  entry.from === 'cli' ? [entry.frame] : []
)

type Translator = ReturnType<typeof createClaudeJournalTranslator>

/** Replays the capture; `after[i]` runs once frame i is handled (more frames, or the host's calls). */
function replay(
  after: Record<
    number,
    (send: (frame: Record<string, unknown>) => void, t: Translator) => void
  > = {}
) {
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
    after[index]?.((extra) => send(extra, index + 1), translator)
  })
  return turns
}

/** A message someone sent, as the stream echoes it when Claude reads it mid-turn. */
const echo = (uuid: string): Record<string, unknown> => ({
  type: 'user',
  message: { role: 'user', content: 'Also check the logs.' },
  parent_tool_use_id: null,
  session_id: SESSION,
  uuid
})

/** The root agent starting a background command in the wake-up. */
const followUp = (send: (frame: Record<string, unknown>) => void) => {
  send({
    type: 'assistant',
    message: {
      id: 'msg_follow',
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_follow', name: 'Bash', input: { command: 'sleep 5' } }
      ]
    },
    parent_tool_use_id: null,
    session_id: SESSION,
    uuid: 'follow-assistant'
  })
  send({
    type: 'system',
    subtype: 'task_started',
    task_id: 'bfollow1',
    tool_use_id: 'toolu_follow',
    description: 'Sleep',
    task_type: 'local_bash',
    is_backgrounded: true,
    session_id: SESSION,
    uuid: 'follow-started'
  })
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
  const turns = replay({ 18: (send) => send(other) })
  expect(turns.at(-1)).toMatchObject({ wokenBy: [RUN, 'toolu_private'] })
})

it('keeps no names on the ended row once a finish into the wake-up names no run', () => {
  const unnamed: Record<string, unknown> = { ...frames[17], uuid: 'unnamed-notification' }
  delete unnamed.tool_use_id
  const turns = replay({ 18: (send) => send(unnamed) })
  const running = turns.findLast((row) => row.state === 'running' && row.wokenBy)!
  const ended = turns.at(-1)!
  expect(running.wokenBy).toEqual([RUN])
  expect(ended.wokenBy).toBeUndefined()
  // The journal merges each revision into the row it has; the ended row must not keep the names.
  const merged = resolveAgentJournalTurnRowWrite(
    { itemBody: () => running, newestTurn: () => null, contextWindowHeld: () => false },
    { identity: { provider: 'claude', sessionId: SESSION, uuid: 'turn' } },
    { lifecycle: ended },
    Number.MAX_SAFE_INTEGER
  )
  expect(merged?.body.wokenBy).toBeUndefined()
})

it('stamps a launch with the send that opened its turn', () => {
  const turns = replay()
  expect(turns.find((row) => row.launches)?.launches).toEqual([
    { run: RUN, sends: ['c1'], runs: [] }
  ])
})

it('stamps a launch with a send steered in before it, and none after an unnamed message', () => {
  const named = replay({
    3: (send, t) => {
      t.turnCycle.steered('c2')
      send(echo('steer-1'))
    }
  })
  expect(named.find((row) => row.launches)?.launches).toEqual([
    { run: RUN, sends: ['c1', 'c2'], runs: [] }
  ])
  const unnamed = replay({ 3: (send) => send(echo('steer-1')) })
  expect(unnamed.some((row) => row.launches)).toBe(false)
})

it('stamps a wake-up’s launch with the run that woke it, and a message into it drops its names', () => {
  const woken = replay({ 18: followUp })
  expect(woken.at(-1)).toMatchObject({
    wokenBy: [RUN],
    launches: [{ run: 'toolu_follow', sends: [], runs: [RUN] }]
  })
  const messaged = replay({
    18: (send, t) => {
      t.turnCycle.steered('c3')
      send(echo('steer-2'))
    }
  })
  expect(messaged.at(-1)?.wokenBy).toBeUndefined()
})

it('names nothing on a wake-up after a message reached Claude between turns', () => {
  const turns = replay({ 11: (send) => send(echo('late-echo')) })
  expect(turns.at(-1)?.wokenBy).toBeUndefined()
})

it('drops a wake-up’s names when an image someone sent reaches it', () => {
  const image = {
    ...echo('image-echo'),
    message: {
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', data: 'AA==' } }]
    }
  }
  const turns = replay({ 18: (send) => send(image) })
  expect(turns.at(-1)?.wokenBy).toBeUndefined()
})
