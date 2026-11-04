import { describe, expect, it } from 'vitest'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import { CodexSubagentExecutions } from './codex-subagent-executions'

describe('CodexSubagentExecutions retention and identity', () => {
  it('bounds settled turn history through repeated execution without evicting live children', () => {
    const executions = new CodexSubagentExecutions()
    executions.register('long-lived', 'long-lived')
    executions.observeTurn('long-lived', 'long-lived-turn', 'working')
    for (let index = 0; index < 1_000; index++) {
      const id = `child-${index}`
      executions.observeTurn(id, id, 'working')
      executions.register(id, id)
      executions.observeTurn(id, id, 'completed')
    }
    expect(executions.workingChildren().map((child) => child.agentThreadId)).toEqual(['long-lived'])
    expect(executions.retentionSizes().settledTurns).toBeLessThanOrEqual(256)
  })

  it('targets live descendants through settled ancestors without losing historical lineage order', () => {
    const executions = new CodexSubagentExecutions()
    executions.register('root', 'root', 'primary')
    executions.observeTurn('root', 'root-turn', 'working')
    const finished = Array.from({ length: 10_000 }, (_, index) => `finished-${index}`)
    for (const id of finished) {
      executions.register(id, id, 'root')
      executions.observeTurn(id, `${id}-turn`, 'completed')
    }
    executions.register('settled-parent', 'settled parent', 'root')
    executions.observeTurn('settled-parent', 'settled-turn', 'completed')
    executions.register('live-descendant', 'live descendant', 'settled-parent')
    executions.observeTurn('live-descendant', 'live-turn', 'working')
    executions.register('sibling', 'sibling', 'root')
    executions.observeTurn('sibling', 'sibling-turn', 'working')

    expect(executions.lineage('root').map((child) => child.agentThreadId)).toEqual([
      'root',
      'sibling',
      'settled-parent',
      'live-descendant',
      ...finished.toReversed()
    ])
    const tracker = new CodexBackgroundTaskTracker('primary', executions)
    expect(tracker.subagentStopTargets(['root'])).toEqual({
      turns: [
        { threadId: 'root', turnId: 'root-turn' },
        { threadId: 'sibling', turnId: 'sibling-turn' },
        { threadId: 'live-descendant', turnId: 'live-turn' }
      ],
      terminals: []
    })
  })

  it('corrects an unverifiable execution with its own terminal event and ignores stale starts', () => {
    const executions = new CodexSubagentExecutions()
    executions.register('child', 'child')
    executions.observeTurn('child', 'turn', 'working')
    executions.closeThread('child')
    expect(executions.workingChildren()).toEqual([])
    expect(executions.observeTurn('child', 'turn', 'working')).toBeNull()
    expect(executions.observeTurn('child', 'turn', 'completed')?.execution.state).toBe('completed')
    executions.observeTurn('child', 'new-turn', 'working')
    executions.observeTurn('child', 'turn', 'failed')
    expect(executions.workingChildren()[0]?.execution?.turnId).toBe('new-turn')
    executions.clear()
    expect(executions.retentionSizes()).toEqual({ children: 0, settledTurns: 0 })
  })
})
