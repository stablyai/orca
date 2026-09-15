import { describe, expect, it } from 'vitest'
import { CodexSubagentExecutions } from './codex-subagent-executions'

describe('CodexSubagentExecutions retention and identity', () => {
  it('bounds settled history through repeated execution without evicting live children', () => {
    const executions = new CodexSubagentExecutions()
    executions.register('long-lived', 'long-lived', 'parent')
    executions.observeTurn('long-lived', 'long-lived-turn', 'working')
    for (let index = 0; index < 1_000; index++) {
      const id = `child-${index}`
      executions.observeTurn(id, id, 'working')
      executions.register(id, id, 'parent')
      executions.observeTurn(id, id, 'completed')
    }
    expect(executions.workingChildren().map((child) => child.agentThreadId)).toEqual(['long-lived'])
    expect(Reflect.get(executions, 'children').size).toBeLessThanOrEqual(128)
    expect(Reflect.get(executions, 'settledTurns').size).toBeLessThanOrEqual(256)
  })

  it('retains early live owner events at capacity and makes room only after settlement', () => {
    const executions = new CodexSubagentExecutions()
    for (let index = 0; index < 128; index++) {
      executions.observeTurn(`child-${index}`, `turn-${index}`, 'working')
    }
    expect(executions.observeTurn('overflow', 'overflow', 'working')).toBeNull()
    for (let index = 0; index < 128; index++) {
      executions.register(`child-${index}`, `child-${index}`, 'parent')
    }
    expect(executions.workingChildren()).toHaveLength(128)
    executions.observeTurn('child-0', 'turn-0', 'completed')
    expect(executions.observeTurn('overflow', 'overflow', 'working')).not.toBeNull()
    executions.register('overflow', 'overflow', 'parent')
    expect(executions.workingChildren()).toHaveLength(128)
  })

  it('corrects an unverifiable execution with its own terminal event and ignores stale starts', () => {
    const executions = new CodexSubagentExecutions()
    executions.register('child', 'child', 'parent')
    executions.observeTurn('child', 'turn', 'working')
    executions.settleSession()
    expect(executions.workingChildren()).toEqual([])
    expect(executions.observeTurn('child', 'turn', 'working')).toBeNull()
    expect(executions.observeTurn('child', 'turn', 'completed')?.execution.state).toBe('completed')
    executions.observeTurn('child', 'new-turn', 'working')
    executions.observeTurn('child', 'turn', 'failed')
    expect(executions.workingChildren()[0]?.execution?.turnId).toBe('new-turn')
    executions.clear()
    expect(Reflect.get(executions, 'children').size).toBe(0)
    expect(Reflect.get(executions, 'settledTurns').size).toBe(0)
  })
})
