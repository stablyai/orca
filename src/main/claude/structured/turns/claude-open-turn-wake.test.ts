import { expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import capture from '../../__fixtures__/claude-subagent-permission-frames.json'
import { createClaudeJournalTranslator } from '../journal/claude-structured-journal-translation'
import {
  agentJournalTurnRowReservedBytes,
  resolveAgentJournalTurnRowWrite
} from '../../../native-chat/agent-session-timeline/agent-journal-turn-row-revision'

// Claude resumes on its own when a background task finishes. In the SDK's own order the system
// task_notification frame (naming the finished run by the call that started it) arrives between turns
// and opens that turn; the turn records the run, so Orca can tell whose work woke the chat.

// The run: the call that started the background task.
const RUN = 'toolu_0113cofGsD2kJXoxmbapdZbE'
const SESSION = 'capture-bg-allow'
const SHELL = 'bshell001'
/** The captured background subagent: the root Agent call, its own work, its finish and wake-up. */
const agentFrames = capture.scenarios['bg-allow'].flatMap((entry): Record<string, unknown>[] =>
  entry.from === 'cli' ? [entry.frame] : []
)
/** The same turns with the root agent starting a background shell instead: its Bash call with
 *  run_in_background, the task the CLI reports for it, and none of the subagent's own frames. */
const frames = agentFrames.flatMap((frame, index): Record<string, unknown>[] => {
  if ([6, 7, 8, 9, 13, 14].includes(index)) {
    return []
  }
  if (index === 2) {
    return [
      rootToolUse('msg_capture_9', RUN, 'Bash', { command: 'sleep 30', run_in_background: true })
    ]
  }
  if (index === 3) {
    return [
      { ...frame, tasks: [{ task_id: SHELL, task_type: 'local_bash', description: 'Sleep' }] }
    ]
  }
  if (index === 4) {
    return [shellStarted(SHELL, RUN)]
  }
  return index === 16 || index === 17 ? [{ ...frame, task_id: SHELL }] : [frame]
})
/** Positions in `frames`: the launch, the first turn's end, the finish and the wake-up's reply. */
const LAUNCHED = 4
const ENDED = 7
const WOKEN = 11

/** The root agent's call, as the stream shows it. */
function rootToolUse(
  id: string,
  call: string,
  name: string,
  input: Record<string, unknown>,
  parent: string | null = null
): Record<string, unknown> {
  return {
    type: 'assistant',
    message: { id, role: 'assistant', content: [{ type: 'tool_use', id: call, name, input }] },
    parent_tool_use_id: parent,
    session_id: SESSION,
    uuid: `${id}-assistant`
  }
}

/** The CLI reporting a background shell it started. */
function shellStarted(taskId: string, call: string): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: call,
    description: 'Sleep',
    task_type: 'local_bash',
    is_backgrounded: true,
    session_id: SESSION,
    uuid: `${taskId}-started`
  }
}

type Translator = ReturnType<typeof createClaudeJournalTranslator>

/** Replays the capture; `after[i]` runs once frame i is handled (more frames, or the host's calls). */
function replay(
  after: Record<
    number,
    (send: (frame: Record<string, unknown>) => void, t: Translator) => void
  > = {},
  source = frames
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
  source.forEach((frame, index) => {
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
  send(
    rootToolUse('msg_follow', 'toolu_follow', 'Bash', {
      command: 'sleep 5',
      run_in_background: true
    })
  )
  send(shellStarted('bfollow1', 'toolu_follow'))
}

it('names the task whose notification opened the turn, in the SDK frame order', () => {
  const turns = replay()
  expect(turns.at(-1)).toMatchObject({ wokenBy: [RUN] })
  expect(turns.filter((row) => !row.wokenBy).length).toBeGreaterThan(0)
})

it('names a task that finishes into the wake-up too', () => {
  const other = {
    ...frames[WOKEN],
    task_id: 'private-job',
    tool_use_id: 'toolu_private',
    uuid: 'other'
  }
  const turns = replay({ [WOKEN]: (send) => send(other) })
  expect(turns.at(-1)).toMatchObject({ wokenBy: [RUN, 'toolu_private'] })
})

it('keeps no names on the ended row once a finish into the wake-up names no run', () => {
  const unnamed: Record<string, unknown> = { ...frames[WOKEN], uuid: 'unnamed-notification' }
  delete unnamed.tool_use_id
  const turns = replay({ [WOKEN]: (send) => send(unnamed) })
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

it('stamps a background shell’s launch with the send that opened its turn', () => {
  const turns = replay()
  expect(turns.find((row) => row.launches)?.launches).toEqual([
    { run: RUN, sends: ['c1'], runs: [] }
  ])
})

it('stamps no launch of a subagent, a Monitor, or a shell a subagent starts', () => {
  expect(replay({}, agentFrames).some((row) => row.launches)).toBe(false)
  const monitor = replay({
    [LAUNCHED]: (send) => {
      send(rootToolUse('msg_monitor', 'toolu_monitor', 'Monitor', { command: 'tail -f log' }))
      send(shellStarted('bmonitor1', 'toolu_monitor'))
    }
  })
  expect(monitor.findLast((row) => row.launches)?.launches?.map((launch) => launch.run)).toEqual([
    RUN
  ])
  const childShell = replay(
    {
      5: (send) => {
        send(
          rootToolUse(
            'msg_child',
            'toolu_child',
            'Bash',
            { command: 'sleep 9', run_in_background: true },
            RUN
          )
        )
        send(shellStarted('bchild1', 'toolu_child'))
      }
    },
    agentFrames
  )
  expect(childShell.some((row) => row.launches)).toBe(false)
})

it('stamps a launch after a foreground command finished in its turn', () => {
  const turns = replay({
    [LAUNCHED - 2]: (send) => {
      send(rootToolUse('msg_fg', 'toolu_fg', 'Bash', { command: 'sleep 1' }))
      send({ ...shellStarted('bfg1', 'toolu_fg'), is_backgrounded: false })
      send(finish('bfg1', 'toolu_fg'))
    }
  })
  expect(turns.find((row) => row.launches)?.launches).toEqual([
    { run: RUN, sends: ['c1'], runs: [] }
  ])
})

it('stamps a launch with a send steered in before it, and none after an unnamed message', () => {
  const named = replay({
    [LAUNCHED - 1]: (send, t) => {
      t.turnCycle.steered('c2')
      send(echo('steer-1'))
    }
  })
  expect(named.find((row) => row.launches)?.launches).toEqual([
    { run: RUN, sends: ['c1', 'c2'], runs: [] }
  ])
  const unnamed = replay({ [LAUNCHED - 1]: (send) => send(echo('steer-1')) })
  expect(unnamed.some((row) => row.launches)).toBe(false)
})

it('stamps a wake-up’s launch with the run that woke it, and a message into it drops its names', () => {
  const woken = replay({ [WOKEN]: followUp })
  expect(woken.at(-1)).toMatchObject({
    wokenBy: [RUN],
    launches: [{ run: 'toolu_follow', sends: [], runs: [RUN] }]
  })
  const messaged = replay({
    [WOKEN]: (send, t) => {
      t.turnCycle.steered('c3')
      send(echo('steer-2'))
    }
  })
  expect(messaged.at(-1)?.wokenBy).toBeUndefined()
})

it('names nothing on a wake-up after a message reached Claude between turns', () => {
  const turns = replay({ [ENDED]: (send) => send(echo('late-echo')) })
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
  const turns = replay({ [WOKEN]: (send) => send(image) })
  expect(turns.at(-1)?.wokenBy).toBeUndefined()
})

/** A task finishing, as the SDK reports it. */
function finish(taskId: string, run: string, status = 'completed'): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    tool_use_id: run,
    status,
    session_id: SESSION,
    uuid: `finish-${run}`
  }
}

it('stamps nothing after a prompt is answered, and a wake-up whose prompt is answered names nothing', () => {
  const launched = replay({ [LAUNCHED - 1]: (_send, t) => t.turnCycle.promptAnswered() })
  expect(launched.some((row) => row.launches)).toBe(false)
  const woken = replay({ [WOKEN]: (_send, t) => t.turnCycle.promptAnswered() })
  expect(woken.at(-1)?.wokenBy).toBeUndefined()
})

it('names nothing on a wake-up after a prompt was answered between turns', () => {
  const turns = replay({ [ENDED]: (_send, t) => t.turnCycle.promptAnswered() })
  expect(turns.at(-1)?.wokenBy).toBeUndefined()
})

it('names nothing on a wake-up for a stopped run, between turns or into it', () => {
  const stop = (frame: Record<string, unknown>, index: number) =>
    index === WOKEN - 1
      ? { ...frame, patch: { status: 'stopped' } }
      : index === WOKEN
        ? { ...frame, status: 'stopped' }
        : frame
  const between = replay({}, frames.map(stop))
  expect(between.at(-1)?.turnId).toBe(replay().at(-1)?.turnId)
  expect(between.findLast((row) => row.wokenBy)).toBeUndefined()
  // Without the update first, the stopped notification alone opens the wake-up.
  const notified = replay(
    {},
    frames.map(stop).filter((_frame, index) => index !== WOKEN - 1)
  )
  expect(notified.length).toBeGreaterThan(2)
  expect(notified.findLast((row) => row.wokenBy)).toBeUndefined()
  const into = replay({ [WOKEN]: (send) => send(finish('bother1', 'toolu_other', 'stopped')) })
  expect(into.at(-1)?.wokenBy).toBeUndefined()
})

it('drops a launch whose run finishes inside the turn that launched it', () => {
  const turns = replay({ [LAUNCHED]: (send) => send(finish(SHELL, RUN)) })
  const launching = turns.find((row) => row.launches)?.turnId
  expect(launching).toBeDefined()
  expect(turns.findLast((row) => row.turnId === launching)?.launches).toBeUndefined()
})

it('keeps a subagent’s own finish out of a wake-up’s names', () => {
  const turns = replay(
    {
      5: (send) => send(rootToolUse('msg_child', 'toolu_child', 'Bash', { command: 'ls' }, RUN)),
      18: (send) => send(finish('bchild1', 'toolu_child'))
    },
    agentFrames
  )
  expect(turns.at(-1)?.wokenBy).toEqual([RUN])
})

it('keeps a turn with the most launches small enough for a context-only revision', () => {
  const turns = replay({
    [LAUNCHED - 1]: (send, t) => {
      for (let i = 0; i < 15; i++) {
        t.turnCycle.steered(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
        send(echo(`steer-${i}`))
      }
    },
    [LAUNCHED]: (send) => {
      for (let i = 0; i < 20; i++) {
        send(
          rootToolUse(`msg_more${i}`, `toolu_more${i}`, 'Bash', {
            command: 'sleep 9',
            run_in_background: true
          })
        )
        send(shellStarted(`bmore${i}`, `toolu_more${i}`))
      }
    }
  })
  const row = turns.findLast((turn) => turn.state === 'running' && turn.launches)!
  expect(row.launches!.length).toBeGreaterThan(1)
  const identity = { provider: 'claude' as const, sessionId: SESSION, uuid: 'turn' }
  const usage = {
    inputTokens: 9,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 1
  }
  const write = {
    contextUsage: {
      window: { tokens: 200_000, capturedAt: 1 },
      used: { kind: 'estimate' as const, usage, capturedAt: 1 }
    }
  }
  const revised = resolveAgentJournalTurnRowWrite(
    { itemBody: () => row, newestTurn: () => null, contextWindowHeld: () => false },
    { identity },
    write,
    agentJournalTurnRowReservedBytes({ identity }, write)
  )
  expect(revised?.body.contextUsage?.window?.tokens).toBe(200_000)
})
