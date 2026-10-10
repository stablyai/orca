import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import type { AgentChildWorkView } from '../../../src/shared/agent-status-child-work-view'
import { normalizeAgentSubagentsField } from '../../../src/shared/agent-status-subagent-snapshot'
import { worktreeAgentChildRows } from './worktree-agent-child-rows'

function parent(fields: Partial<RuntimeWorktreeAgentRow> = {}): RuntimeWorktreeAgentRow {
  return {
    paneKey: 'parent',
    parentPaneKey: null,
    state: 'working',
    agentType: 'codex',
    prompt: 'Implement rows',
    taskTitle: null,
    displayName: null,
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: 100,
    updatedAt: 1_000,
    ...fields
  }
}

function child(fields: Partial<AgentChildWorkView> = {}): AgentChildWorkView {
  return {
    id: 'native',
    kind: 'agent',
    name: 'Review tests',
    state: 'working',
    membership: 'live',
    firstObservedAt: 100,
    observedAt: 900,
    stoppable: false,
    invocation: { invocationId: 'spawn', generation: 1 },
    ...fields
  }
}

describe('phone worktree child presentation', () => {
  it('withholds numeric ages and live claims until this host clock is calibrated', () => {
    const row = parent({ children: [child()], structuredHostOwned: true })
    const uncalibrated = worktreeAgentChildRows(row, 3_602_000, true, undefined)
    expect(uncalibrated.rows[0]).toMatchObject({
      displayState: 'unverifiable',
      detail: { kind: 'reason', state: 'unverifiable' }
    })
    expect(uncalibrated.elapsedNow).toBeUndefined()
  })
  it('has no child rows on old hosts and respects explicit empty native data', () => {
    expect(worktreeAgentChildRows(parent(), 2_000, true, 0).rows).toEqual([])
    expect(
      worktreeAgentChildRows(
        parent({ children: [], subagents: [{ id: 'old', state: 'working', startedAt: 100 }] }),
        2_000,
        true,
        0
      ).rows
    ).toEqual([])
  })

  it('calibrates native evidence/elapsed on the host clock without renewing evidence', () => {
    const row = parent({ children: [child()] })
    const initial = worktreeAgentChildRows(row, 3_602_000, true, 3_600_000)
    expect(initial.rows[0].recencyAt).toBe(3_600_900)
    expect(initial.rows[0].displayState).toBe('working')
    expect(initial.elapsedNow).toBe(2_000)
    const replay = worktreeAgentChildRows(row, 5_402_000, true, 3_600_000)
    expect(replay.rows[0].displayState).toBe('unverifiable')
    expect(replay.rows[0].recencyAt).toBe(initial.rows[0].recencyAt)
  })

  it('makes retained owned rows unverifiable on disconnection without settling them', () => {
    const row = parent({ children: [child()], structuredHostOwned: true })
    expect(worktreeAgentChildRows(row, 9_000_000, true, 0).rows[0].displayState).toBe('working')
    const lost = worktreeAgentChildRows(row, 9_000_000, false, 0).rows[0]
    expect(lost.displayState).toBe('unverifiable')
    expect(lost.settled).toBe(false)
  })

  it.each([3_600_000, -3_600_000])(
    'withholds elapsed for an unproven relay clock skew %s',
    (skew) => {
      const row = parent({ subagents: [{ id: 'cli', state: 'working', startedAt: 100 + skew }] })
      const remote = worktreeAgentChildRows(row, 2_000, true, 0)
      expect(remote.rows[0].id).toBe('cli')
      expect(remote.rows[0].displayState).toBe('working')
      expect(remote.elapsedNow).toBeUndefined()
      expect(
        worktreeAgentChildRows({ ...row, subagentClockOffsetMs: 0 }, 2_000, true, 0).elapsedNow
      ).toBe(2_000)
    }
  )

  it('degrades future native and CLI state words, keeping producer normalization strict', () => {
    const future = Object.assign(child(), {
      state: 'future-state',
      membership: 'future-membership'
    })
    expect(
      worktreeAgentChildRows(parent({ children: [future] }), 2_000, true, 0).rows[0]
    ).toMatchObject({ id: 'native', displayState: 'unverifiable' })
    const roster = [Object.assign({ id: 'cli', startedAt: 100 }, { state: 'future-state' })]
    expect(normalizeAgentSubagentsField(roster)).toBeUndefined()
    expect(
      worktreeAgentChildRows(Object.assign(parent(), { subagents: roster }), 2_000, true, 0).rows[0]
    ).toMatchObject({ id: 'cli', displayState: 'unverifiable' })
    expect(
      worktreeAgentChildRows(
        Object.assign(parent(), { subagents: [{ id: 'bad', state: 42 }] }),
        2_000,
        true,
        0
      ).rows
    ).toEqual([])
  })
})
