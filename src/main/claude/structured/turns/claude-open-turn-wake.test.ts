import { expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import capture from '../../__fixtures__/claude-subagent-permission-frames.json'
import { createClaudeJournalTranslator } from '../journal/claude-structured-journal-translation'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { claudeTurnLifecycleIdentity } from './claude-turn-lifecycle-item'
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
/** What the host knows of a send as a frame arrives: the send it opens, or one handed to Claude
 *  and not yet echoed. */
type SendFacts = {
  startsTurn?: true
  clientMessageId?: string
  requestedAt?: number
  startedSend?: { clientMessageId: string }
  handedSends?: { ids: readonly string[]; unnamed: boolean }
  handedPending?: true
}
const opens = (clientMessageId: string): SendFacts => ({ startsTurn: true, clientMessageId })
const handed = (ids: string[], unnamed = false): SendFacts => ({ handedSends: { ids, unnamed } })
const noneHanded = handed([])
/** What a real host marks on a frame by default: the opening send is on its list until its echo. */
const hostFacts = (index: number): SendFacts => (index === 0 ? { handedPending: true } : {})

/** Replays the capture; `after[i]` runs once frame i is handled (more frames, or the host's calls). */
function replay(
  after: Record<
    number,
    (send: (frame: Record<string, unknown>, event?: SendFacts) => void, t: Translator) => void
  > = {},
  source = frames,
  tagged: Record<number, SendFacts> = {}
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
  // A task's start carries Orca's list of sends it handed Claude: none outstanding unless given.
  const send = (message: Record<string, unknown>, at: number, event: SendFacts = {}) =>
    translator.handle({
      type: 'message',
      sessionId: SESSION,
      message,
      observedAt: at,
      ...(message.subtype === 'task_started' && !('handedSends' in event) ? noneHanded : {}),
      ...event
    })
  source.forEach((frame, index) => {
    send(frame, index + 1, index === 1 ? opens('c1') : (tagged[index] ?? hostFacts(index)))
    after[index]?.((extra, event) => send(extra, index + 1, event), translator)
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

/** The follow-up shell's launch in the last turn, if one was recorded. */
const followUpLaunch = (turns: ReturnType<typeof replay>) =>
  turns.at(-1)?.launches?.find((launch) => launch.run === 'toolu_follow')

/** Frames `from`..`to` arriving while send `id` was handed to Claude and not yet echoed. */
const sentBefore = (id: string, from: number, to: number): Record<number, SendFacts> =>
  Object.fromEntries(
    Array.from({ length: to - from + 1 }, (_, i) => [
      from + i,
      { startedSend: { clientMessageId: id } }
    ])
  )

it('keeps a finish as an input of the turn a send opens with it, and names no wake-up', () => {
  // A thread send is handed to Claude as Orca's subagent finishes; the finish opens the turn.
  const subagent = replay({ 17: followUp }, agentFrames, sentBefore('c2', 15, 17))
  const opened = subagent.at(-1)?.turnId
  expect(subagent.filter((row) => row.turnId === opened).some((row) => row.wokenBy)).toBe(false)
  expect(followUpLaunch(subagent)?.runs ?? [RUN]).toContain(RUN)
  const shell = replay({ [WOKEN]: followUp }, frames, sentBefore('c2', WOKEN - 2, WOKEN))
  expect(shell.at(-1)?.wokenBy).toBeUndefined()
  expect(followUpLaunch(shell)?.runs ?? [RUN]).toContain(RUN)
})

/** A turn ends on a usage limit with no result, so Orca opens no turn for output until a send:
 *  a finish then waits between turns, and the send's echo opens the next turn. */
const limitedThenSend = (status: string) =>
  replay(
    {
      2: (send) => {
        send({
          type: 'assistant',
          message: {
            id: 'msg_limit',
            role: 'assistant',
            content: [{ type: 'text', text: 'Limit reached' }]
          },
          api_error: 'usage_limit_reached',
          parent_tool_use_id: null,
          session_id: SESSION,
          uuid: 'limit-assistant'
        })
        send({
          type: 'system',
          subtype: 'session_state_changed',
          state: 'idle',
          session_id: SESSION,
          uuid: 'idle'
        })
        send(finish('bprivate1', 'toolu_private', status))
        send(echo('c5-echo'), opens('c5'))
        followUp(send)
      }
    },
    frames.slice(0, 3)
  )

it('keeps a finish as an input of the turn a send’s echo opens after it', () => {
  const turns = limitedThenSend('completed')
  expect(turns.at(-1)?.turnId).toBe('c5-echo')
  expect(turns.at(-1)?.wokenBy).toBeUndefined()
  expect(followUpLaunch(turns)?.runs ?? ['toolu_private']).toContain('toolu_private')
})

it('records no launch in a turn a send opens after a stopped run', () => {
  const turns = limitedThenSend('stopped')
  expect(turns.at(-1)?.turnId).toBe('c5-echo')
  expect(followUpLaunch(turns)).toBeUndefined()
})

it('records no launch in a send turn that replaces an open wake-up', () => {
  const turns = replay({
    [WOKEN]: (send) => {
      send(echo('c6-echo'), opens('c6'))
      followUp(send)
    }
  })
  expect(turns.at(-1)?.turnId).toBe('c6-echo')
  expect(followUpLaunch(turns)).toBeUndefined()
})

it('stamps a launch with every send Orca handed Claude, echoed or not, behind the opener too', () => {
  const thread = replay({}, frames, { [LAUNCHED]: handed(['c1']) })
  expect(thread.find((row) => row.launches)?.launches).toEqual([
    { run: RUN, sends: ['c1'], runs: [] }
  ])
  const behind = replay({}, frames, { [LAUNCHED]: handed(['c1', 'c9']) })
  expect(behind.find((row) => row.launches)?.launches).toEqual([
    { run: RUN, sends: ['c1', 'c9'], runs: [] }
  ])
})

it('records no launch while Orca holds a send it can’t name, or holds no list', () => {
  expect(replay({}, frames, { [LAUNCHED]: handed(['c1'], true) }).some((row) => row.launches)).toBe(
    false
  )
  expect(
    replay({}, frames, { [LAUNCHED]: { handedSends: undefined } }).some((row) => row.launches)
  ).toBe(false)
})

it('drops a wake-up’s names for good once Orca holds a send it handed Claude, echoed or not', () => {
  const inside = replay({}, frames, { [WOKEN + 1]: { handedPending: true } })
  const woken = inside.at(-1)?.turnId
  expect(inside.find((row) => row.turnId === woken)?.wokenBy).toEqual([RUN])
  expect(inside.at(-1)?.wokenBy).toBeUndefined()
  // Seen first on the frame that ends it: the names leave before the end is saved.
  const atEnd = replay({}, frames, { [frames.length - 1]: { handedPending: true } })
  expect(atEnd.filter((row) => row.state !== 'running').some((row) => row.wokenBy)).toBe(false)
})

it('names nothing on a wake-up after Orca held a send between turns', () => {
  const turns = replay({}, frames, { [ENDED + 1]: { handedPending: true } })
  expect(turns.at(-1)?.turnId).toBe(replay().at(-1)?.turnId)
  expect(turns.some((row) => row.turnId === turns.at(-1)?.turnId && row.wokenBy)).toBe(false)
})

it('records on a wake-up the row that launched each run it names, and only a recorded launch', () => {
  const turns = replay()
  const launching = turns.find((row) => row.launches)!.turnId
  expect(turns.at(-1)?.wokeFrom).toEqual([
    { run: RUN, turn: agentJournalItemKey(claudeTurnLifecycleIdentity(SESSION, launching)) }
  ])
  // The launch wasn't recorded (an unnamed message came first): the wake-up names its run, no row.
  const unrecorded = replay({ [LAUNCHED - 1]: (send) => send(echo('steer-1')) })
  expect(unrecorded.at(-1)).toMatchObject({ wokenBy: [RUN] })
  expect(unrecorded.at(-1)?.wokeFrom).toBeUndefined()
  // Its names dropped, it points at no launch either.
  const messaged = replay({ [WOKEN + 1]: (send) => send(echo('late')) })
  expect(messaged.at(-1)?.wokeFrom).toBeUndefined()
})

it('stamps a thread turn’s launch though its own send was outstanding before its echo', () => {
  // The host marks the frames before the opening send's echo: that send is still on its list.
  const turns = replay({}, frames, { 0: { handedPending: true } })
  expect(turns.find((row) => row.launches)?.launches).toEqual([
    { run: RUN, sends: ['c1'], runs: [] }
  ])
})
