import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionThreadGoalReport } from '../../../../shared/agent-session/thread-goals/agent-session-thread-goal-report'
import { isAgentJournalThreadGoalRow } from '../../../../shared/agent-session/thread-goals/agent-session-thread-goal'
import { journalThreadGoalSource } from '../../../native-chat/agent-session-journal/projection/journal-thread-goal-source'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

// Recorded /goal run: each unmet check is a synthetic user frame labelled with the objective.
const frames: Record<string, unknown>[] = readFileSync(
  join(__dirname, '../../__fixtures__/claude-adapter-capture-slash-goal.jsonl'),
  'utf8'
)
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line))
  .filter((entry) => entry.kind === 'frame')
  .map((entry) => entry.frame)

function fixtureFrame(match: (frame: Record<string, unknown>) => boolean) {
  const found = frames.find(match)
  if (!found) {
    throw new Error('frame missing from the /goal fixture')
  }
  return found
}

const check = fixtureFrame((frame) => frame.isSynthetic === true)
const answer = fixtureFrame(
  (frame) =>
    frame.type === 'assistant' &&
    frame.parent_tool_use_id === null &&
    JSON.stringify(frame).includes('What can I help')
)
const laterCheck = (uuid: string) => ({
  ...check,
  uuid,
  message: {
    role: 'user',
    content: [
      {
        type: 'text',
        text: 'Stop hook feedback:\n[the user has typed the word banana in a later message]: Still no banana.'
      }
    ]
  }
})

function goalSession(items: AgentJournalRenderItem[], restored = false) {
  const journal = createClaudeJournalTranslator({
    goalBackgroundWork: () => 'exited',
    sink: {
      appendItem: (identity, body) => {
        const itemId = agentJournalItemKey(identity)
        const existing = items.find((item) => item.itemId === itemId)
        if (existing) {
          existing.body = body
        } else {
          items.push({ itemId, sequence: items.length + 1, revision: 1, observedAt: 1_000, body })
        }
      },
      appendTombstone: () => {},
      publish: () => {},
      // A restarted host reads the goal back from the saved journal.
      ...(restored
        ? {
            journalSnapshot: () => ({
              canonicalByToolUse: [],
              attemptByAgent: [],
              parents: [],
              backgrounds: [],
              subagents: [],
              threadGoal: journalThreadGoalSource(items)
            })
          }
        : {})
    }
  })
  const send = (message: Record<string, unknown>) =>
    journal.handle({ type: 'message', sessionId: 'orca', observedAt: 1_000, message })
  const result = (uuid: string, subtype: string) =>
    send({
      type: 'result',
      subtype,
      is_error: subtype !== 'success',
      num_turns: 1,
      session_id: check.session_id,
      uuid
    })
  const cleanTurn = (uuid: string) => {
    send({ ...answer, uuid: `${uuid}-answer` })
    result(uuid, 'success')
  }
  return { send, result, cleanTurn }
}

const goalRowTexts = (items: AgentJournalRenderItem[]) =>
  items.flatMap((item) =>
    item.body.kind === 'status' && isAgentJournalThreadGoalRow(item.body) ? [item.body.text] : []
  )

const goal = (items: AgentJournalRenderItem[]) =>
  agentSessionThreadGoalReport({
    journalItems: items,
    support: undefined,
    reported: { current: null }
  })?.goal

function completedGoal() {
  const items: AgentJournalRenderItem[] = []
  const live = goalSession(items)
  for (const frame of frames) {
    live.send(frame)
  }
  live.cleanTurn('result-2')
  expect(goal(items)?.status).toBe('complete')
  return { items, live }
}

it('keeps checks after an inferred completion in the goal row until the goal completes again', () => {
  const { items, live } = completedGoal()

  live.send(laterCheck('check-2'))
  expect(items.at(-1)?.body).toMatchObject({
    presentation: 'goal-check',
    text: 'Stop hook feedback: Still no banana.'
  })
  expect(goal(items)).toMatchObject({ status: 'active', checks: 1, lastCheck: 'Still no banana.' })

  live.cleanTurn('result-3')
  expect(goal(items)?.status).toBe('complete')
})

it('keeps a reopened goal across restarts until it completes again', () => {
  const { items } = completedGoal()
  const completion = items.findLast(
    (item) => item.body.kind === 'status' && item.body.text.startsWith('Goal complete: ')
  )

  const restored = goalSession(items, true)
  restored.send(laterCheck('check-2'))
  restored.result('result-3', 'error_during_execution')
  expect(completion?.body).toMatchObject({
    text: 'Goal active: the user has typed the word banana in a later message',
    threadGoal: { goal: { status: 'active' } }
  })
  expect(goal(items)).toMatchObject({ status: 'active', checks: 1 })

  // The goal passes on its next evaluation, so no further check arrives.
  goalSession(items, true).cleanTurn('result-4')
  expect(goal(items)?.status).toBe('complete')
  expect(completion?.body).toMatchObject({ text: expect.stringMatching(/^Goal complete: /u) })
})

it('revises one goal row in place across repeated reopen and completion cycles', () => {
  const { items, live } = completedGoal()
  const statusRows = () =>
    items.flatMap((item) =>
      item.body.kind === 'status' && item.body.presentation !== 'goal-check' ? [item.itemId] : []
    )
  const settled = { goalRows: goalRowTexts(items), statusRows: statusRows() }

  for (const cycle of [3, 4, 5]) {
    live.send(laterCheck(`check-${cycle}`))
    expect(goal(items)?.status).toBe('active')
    live.cleanTurn(`result-${cycle}`)
    expect(goal(items)?.status).toBe('complete')
  }

  expect(goalRowTexts(items)).toEqual(settled.goalRows)
  expect(statusRows()).toEqual(settled.statusRows)
})
