import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalThreadGoal
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import { journal } from './claude-context-usage-test-support'
import { ClaudeBackgroundTaskTracker } from './claude-background-task-tracker'
import { MOVED_TO_BACKGROUND } from './claude-captured-task-frames.test-fixture'

// Captured from Claude Code 2.1.280: synthetic /goal replies, with no goal frame on completion.
const OBJECTIVE = 'reply with exactly the word done'

function goalSink(
  journalGoal: AgentJournalThreadGoal | null = null,
  journalRow?: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody },
  deferred = false
) {
  const state = journal({ deferred })
  const rows = state.appends
  let stopped = false
  const backgroundTasks = new ClaudeBackgroundTaskTracker()
  const sink: StructuredAgentSessionEventSink = {
    ...state.sink,
    appendTombstone: vi.fn(),
    publish: vi.fn(),
    journalStopDecidesTurn: () => stopped,
    journalLinkage: () => ({
      epoch: 'test',
      visitItemsWithLinkage: () => {},
      threadGoal: () => journalGoal,
      threadGoalSource: () => ({
        goal: journalGoal,
        row:
          journalRow?.body.kind === 'status'
            ? { identity: journalRow.identity, text: journalRow.body.text }
            : null
      })
    })
  }
  const translator = createClaudeJournalTranslator({
    sink,
    coalesceMs: 0,
    goalBackgroundWork: () => backgroundTasks.goalBackgroundWork
  })
  let at = 1_000
  const frame = (message: Record<string, unknown>, elapsedMs = 1_000) => {
    at += elapsedMs
    state.clock.now = at
    backgroundTasks.observe(message)
    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      observedAt: at,
      message: { session_id: 'claude-session', parent_tool_use_id: null, ...message }
    })
  }
  const reply = (uuid: string, model: string, text: string) =>
    frame({
      type: 'assistant',
      uuid,
      message: { role: 'assistant', model, content: [{ type: 'text', text }] }
    })
  const result = (uuid: string, fields: Record<string, unknown>, elapsedMs?: number) =>
    frame({ type: 'result', uuid, ...fields }, elapsedMs)
  const goals = () =>
    rows.flatMap(({ identity, body }) =>
      body.kind === 'status' && body.threadGoal ? [{ identity, body }] : []
    )
  const savedGoal = () => {
    const body = goals().at(-1)?.body
    return body?.kind === 'status' && body.threadGoal?.state === 'set' ? body.threadGoal.goal : null
  }
  const pressStop = () => {
    stopped = true
  }
  return { frame, reply, result, goals, savedGoal, pressStop, flush: state.flush }
}

describe('Claude /goal journaling', () => {
  it.each([false, true])(
    'journals the goal and its completion before adjacent idle (deferred %s)',
    (deferred) => {
      const { frame, reply, result, goals, flush } = goalSink(null, undefined, deferred)
      reply('goal-set', '<synthetic>', `Goal set: ${OBJECTIVE}`)
      reply('work-1', 'claude-haiku-4-5', 'Working on it.')
      result(
        'result-1',
        { subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns' },
        5_000
      )
      frame({ type: 'system', subtype: 'session_state_changed', state: 'idle' }, 1)
      reply('work-2', 'claude-haiku-4-5', 'done')
      result(
        'result-2',
        { subtype: 'success', is_error: false, terminal_reason: 'completed' },
        3_000
      )
      frame({ type: 'system', subtype: 'session_state_changed', state: 'idle' }, 1)
      flush()

      expect(goals()).toEqual([
        {
          identity: { provider: 'claude', sessionId: 'claude-session', uuid: 'goal-set' },
          body: expect.objectContaining({
            text: `Goal set: ${OBJECTIVE}`,
            threadGoal: {
              state: 'set',
              goal: expect.objectContaining({
                objective: OBJECTIVE,
                status: 'active',
                timeUsedSeconds: 0
              })
            }
          })
        },
        {
          identity: { provider: 'claude', sessionId: 'claude-session', uuid: 'goal-set' },
          body: expect.objectContaining({
            text: `Goal set: ${OBJECTIVE}`,
            threadGoal: {
              state: 'set',
              goal: expect.objectContaining({ status: 'active', timeUsedSeconds: 6 })
            }
          })
        },
        {
          identity: { provider: 'claude', sessionId: 'claude-session', uuid: 'result-2:goal' },
          body: expect.objectContaining({
            text: `Goal complete: ${OBJECTIVE}`,
            threadGoal: {
              state: 'set',
              goal: expect.objectContaining({ status: 'complete', timeUsedSeconds: 10 })
            }
          })
        }
      ])
    }
  )

  // Captured Stop during the goal check returned success.
  it('keeps the goal open when a person stops the turn, even on a clean result', () => {
    const { reply, result, goals, pressStop } = goalSink()
    reply('goal-set', '<synthetic>', `Goal set: ${OBJECTIVE}`)
    reply('work', 'claude-opus-5-5', 'Still waiting.')
    pressStop()
    result('result', { subtype: 'success', is_error: false, terminal_reason: 'completed' })

    expect(goals().map(({ body }) => body.kind === 'status' && body.text)).toEqual([
      `Goal set: ${OBJECTIVE}`,
      `Goal set: ${OBJECTIVE}`
    ])
    expect(goals().at(-1)?.body).toMatchObject({ threadGoal: { goal: { status: 'active' } } })
  })

  it('keeps the goal active when a captured background Agent outlives a clean root result', () => {
    const { frame, reply, goals } = goalSink()
    reply('goal-set', '<synthetic>', `Goal set: ${OBJECTIVE}`)
    let previousAt = 0
    for (const [index, captured] of MOVED_TO_BACKGROUND.entries()) {
      frame({ uuid: `capture-${index}`, ...captured.frame }, captured.at - previousAt)
      previousAt = captured.at
      if (captured.frame.type === 'result') {
        break
      }
    }

    expect(goals().at(-1)?.body).toMatchObject({
      threadGoal: { goal: { status: 'active' } }
    })
    expect(
      goals().some(({ body }) => body.kind === 'status' && body.text.startsWith('Goal complete'))
    ).toBe(false)
  })

  it('saves elapsed goal time after restart when a person stops the turn', () => {
    const beforeRestart = goalSink()
    beforeRestart.reply('goal-set', '<synthetic>', `Goal set: ${OBJECTIVE}`)

    const afterRestart = goalSink(beforeRestart.savedGoal(), beforeRestart.goals().at(-1))
    afterRestart.reply('work', 'claude-opus-5-5', 'Still waiting.')
    afterRestart.pressStop()
    afterRestart.result(
      'stopped',
      { subtype: 'success', is_error: false, terminal_reason: 'completed' },
      5_000
    )

    expect(afterRestart.goals()).toEqual([
      {
        identity: { provider: 'claude', sessionId: 'claude-session', uuid: 'goal-set' },
        body: expect.objectContaining({
          text: `Goal set: ${OBJECTIVE}`,
          threadGoal: {
            state: 'set',
            goal: expect.objectContaining({ status: 'active', timeUsedSeconds: 5 })
          }
        })
      }
    ])

    const reloaded = goalSink(afterRestart.savedGoal(), afterRestart.goals().at(-1))
    reloaded.reply('status', '<synthetic>', `Goal active: ${OBJECTIVE} (not yet evaluated)`)
    expect(reloaded.goals()[0]?.body).toMatchObject({
      threadGoal: { goal: { status: 'active', timeUsedSeconds: 5 } }
    })
  })

  it('keeps a goal set before a restart open through a status reply, and clears it on /goal clear', () => {
    const objective = 'Ship (2 turns) then go'
    const { reply, result, goals } = goalSink({
      objective,
      status: 'active',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 30,
      createdAt: 1,
      updatedAt: 1
    })
    reply('status', '<synthetic>', `Goal active: ${objective} (not yet evaluated)`)
    result('status-result', { subtype: 'success', is_error: false, num_turns: 0 })
    reply('clear', '<synthetic>', `Goal cleared: ${objective}`)

    expect(goals().map(({ body }) => body.kind === 'status' && body.threadGoal)).toEqual([
      {
        state: 'set',
        goal: expect.objectContaining({ objective, status: 'active', timeUsedSeconds: 30 })
      },
      { state: 'cleared' }
    ])
  })
})
