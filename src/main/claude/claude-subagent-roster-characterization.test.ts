// Golden row writes for the Claude subagent roster: every append, tombstone and publish it makes
// for scripted frame sequences, so moving the roster onto shared code cannot change a saved byte.

import { describe, expect, it } from 'vitest'
import type { AgentJournalTurnScope } from '../../shared/agent-session-journal-types'
import type { NativeChatSubagentEntry } from '../../shared/native-chat-types'
import { recordingSubagentRowSink } from '../native-chat/subagent-row-sink-recorder-test-support'
import type { ClaudeJournaledRosterSource } from './claude-subagent-journaled-roster'
import { ClaudeSubagentRoster } from './claude-subagent-roster'

/** The clock moves once per delivered frame, never per read, so a row's times do not depend on how
 *  often the roster happens to read it. */
function harness(journaled?: ClaudeJournaledRosterSource) {
  const recorder = recordingSubagentRowSink()
  let clock = 1_000
  let key: string | null = 's:turn-1'
  const scope = (): AgentJournalTurnScope =>
    key === null ? { kind: 'thread' } : { kind: 'turn', turnItemId: `turn-row:${key}` }
  const inner = new ClaudeSubagentRoster({
    sink: recorder.sink,
    currentGroupKey: () => key,
    currentTurnScope: scope,
    ...(journaled ? { journaled } : {}),
    now: () => clock
  })
  const tick = <T>(deliver: () => T): T => {
    clock += 10
    return deliver()
  }
  const roster = {
    observeSystemFrame: (message: Record<string, unknown>) =>
      tick(() => inner.observeSystemFrame(message)),
    observeChildActivity: (toolUseId: string) => tick(() => inner.observeChildActivity(toolUseId)),
    observeToolResult: (toolUseId: string, failed: boolean) =>
      tick(() => inner.observeToolResult(toolUseId, failed)),
    settleTurn: (groupKey: string | null) => tick(() => inner.settleTurn(groupKey)),
    settleSession: () => tick(() => inner.settleSession()),
    dispose: () => tick(() => inner.dispose())
  }
  return {
    ...recorder,
    roster,
    turn: (next: string | null) => {
      key = next
    }
  }
}

function frame(subtype: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { type: 'system', subtype, session_id: 's', ...fields }
}

const started = (fields: Record<string, unknown>) =>
  frame('task_started', { task_type: 'local_agent', ...fields })
const notified = (fields: Record<string, unknown>) => frame('task_notification', fields)

describe('Claude subagent roster rows (characterization)', () => {
  it('one foreground child settled by its spawn call result', () => {
    const { roster, log } = harness()
    roster.observeSystemFrame(started({ task_id: 't1', tool_use_id: 'u1', description: 'Audit' }))
    roster.observeSystemFrame(frame('task_progress', { task_id: 't1', tool_use_id: 'u1' }))
    roster.observeToolResult('u1', false)
    roster.observeToolResult('u1', false)
    roster.settleTurn('s:turn-1')
    expect(log).toMatchSnapshot()
  })

  it('two children sharing a label, one backgrounded, through turn end and session end', () => {
    const { roster, log } = harness()
    roster.observeSystemFrame(started({ task_id: 't1', tool_use_id: 'u1', description: 'Audit' }))
    roster.observeSystemFrame(
      started({ task_id: 't2', tool_use_id: 'u2', description: 'Audit', is_backgrounded: true })
    )
    roster.observeSystemFrame(started({ task_id: 't3', tool_use_id: 'u3', description: 'Audit 2' }))
    roster.settleTurn('s:turn-1')
    roster.observeSystemFrame(notified({ task_id: 't3', tool_use_id: 'u3', status: 'completed' }))
    roster.settleSession()
    roster.dispose()
    expect(log).toMatchSnapshot()
  })

  it('verdicts after lost contact, failures and stops', () => {
    const { roster, log } = harness()
    roster.observeSystemFrame(started({ task_id: 't1', tool_use_id: 'u1', description: 'A' }))
    roster.observeSystemFrame(started({ task_id: 't2', tool_use_id: 'u2', description: 'B' }))
    roster.observeSystemFrame(started({ task_id: 't3', tool_use_id: 'u3', description: 'C' }))
    roster.observeSystemFrame(notified({ task_id: 't2', tool_use_id: 'u2', status: 'killed' }))
    roster.observeToolResult('u3', true)
    roster.settleTurn('s:turn-1')
    roster.observeSystemFrame(notified({ task_id: 't1', tool_use_id: 'u1', status: 'completed' }))
    roster.observeSystemFrame(notified({ task_id: 't2', tool_use_id: 'u2', status: 'completed' }))
    expect(log).toMatchSnapshot()
  })

  it('more than 32 settled groups, then a late frame for an evicted child', () => {
    const { roster, log, turn } = harness()
    for (let index = 0; index < 34; index++) {
      turn(`s:turn-${index}`)
      roster.observeSystemFrame(
        started({ task_id: `t${index}`, tool_use_id: `u${index}`, description: `Job ${index}` })
      )
      roster.observeSystemFrame(
        notified({ task_id: `t${index}`, tool_use_id: `u${index}`, status: 'completed' })
      )
    }
    turn('s:turn-live')
    roster.observeSystemFrame(started({ task_id: 'live', tool_use_id: 'ul', description: 'Live' }))
    roster.observeSystemFrame(notified({ task_id: 't0', tool_use_id: 'u0', status: 'failed' }))
    roster.observeSystemFrame(started({ task_id: 't0', tool_use_id: 'u0', description: 'Job 0' }))
    expect(log.length).toMatchSnapshot()
    expect(log.slice(-6)).toMatchSnapshot()
  })

  it('a provisional row from child traffic takes the announced name and canonical id', () => {
    const { roster, log } = harness()
    roster.observeChildActivity('u1')
    roster.observeSystemFrame(started({ task_id: 't1', tool_use_id: 'u1', description: 'Named' }))
    roster.observeChildActivity('u1')
    roster.observeChildActivity('u-unknown')
    roster.observeSystemFrame(notified({ task_id: 't1', tool_use_id: 'u1', status: 'completed' }))
    expect(log).toMatchSnapshot()
  })

  it('an announcement that is not a subagent tombstones the provisional row', () => {
    const { roster, log } = harness()
    roster.observeChildActivity('u1')
    roster.observeSystemFrame(
      frame('task_started', { task_id: 't1', tool_use_id: 'u1', task_type: 'local_bash' })
    )
    roster.observeChildActivity('u1')
    expect(log).toMatchSnapshot()
  })

  it('a resume under a new tool id in a later turn reopens the original row', () => {
    const { roster, log, turn } = harness()
    roster.observeSystemFrame(started({ task_id: 't1', tool_use_id: 'u1', description: 'Audit' }))
    roster.observeToolResult('u1', false)
    roster.settleTurn('s:turn-1')
    turn('s:turn-2')
    roster.observeSystemFrame(started({ task_id: 't1', tool_use_id: 'u1b', description: 'Audit' }))
    roster.observeSystemFrame(notified({ task_id: 't1', tool_use_id: 'u1', status: 'failed' }))
    roster.observeToolResult('u1b', false)
    roster.settleTurn('s:turn-2')
    expect(log).toMatchSnapshot()
  })

  it('a child announced outside any turn is not swept by a turn end', () => {
    const { roster, log, turn } = harness()
    turn(null)
    roster.observeSystemFrame(started({ task_id: 't1', tool_use_id: 'u1', description: 'Loose' }))
    turn('s:turn-9')
    roster.settleTurn('s:turn-9')
    roster.settleTurn(null)
    expect(log).toMatchSnapshot()
  })

  it('a refused append or publish is retried by the next write of that row', () => {
    const { roster, log, refuseNextAppend, refuseNextPublish } = harness()
    refuseNextAppend()
    roster.observeSystemFrame(started({ task_id: 't1', tool_use_id: 'u1', description: 'A' }))
    roster.observeSystemFrame(frame('task_progress', { task_id: 't1', tool_use_id: 'u1' }))
    roster.observeSystemFrame(started({ task_id: 't2', tool_use_id: 'u2', description: 'B' }))
    refuseNextPublish()
    roster.observeToolResult('u2', false)
    roster.observeToolResult('u2', false)
    roster.settleTurn('s:turn-1')
    expect(log).toMatchSnapshot()
  })

  it('a later run inherits the row an earlier run journaled and revises it', () => {
    const earlier: NativeChatSubagentEntry[] = [
      { id: 't1', label: 'Audit', state: 'working', startedAt: 5 },
      { id: 't2', label: 'Audit 2', state: 'completed', startedAt: 6, settledAt: 9 }
    ]
    let claimed = false
    const journaled: ClaudeJournaledRosterSource = {
      canonical: (toolUseId) => (toolUseId === 'u1' ? 't1' : null),
      groupOf: (id) => (id === 't1' || id === 't2' ? 's:turn-0' : null),
      claimGroup: (groupId) => {
        if (groupId !== 's:turn-0' || claimed) {
          return null
        }
        claimed = true
        return { entries: earlier, placement: { kind: 'turn', turnItemId: 'turn-row:s:turn-0' } }
      },
      attempt: (id) => (id === 't1' ? 2 : 1)
    }
    const { roster, log, turn } = harness(journaled)
    turn('s:turn-3')
    roster.observeSystemFrame(notified({ task_id: 't1', status: 'completed' }))
    roster.observeSystemFrame(started({ task_id: 't1', tool_use_id: 'u9', description: 'Audit' }))
    roster.observeSystemFrame(started({ task_id: 't4', tool_use_id: 'u4', description: 'Audit' }))
    roster.settleSession()
    expect(log).toMatchSnapshot()
  })
})
