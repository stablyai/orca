import { describe, expect, it } from 'vitest'
import { CodexSubagentExecutions } from './codex-subagent-executions'

describe('CodexSubagentExecutions retention and identity', () => {
  it('bounds settled history through repeated execution without evicting live children', () => {
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
    const { children, settledTurns } = executions.retentionSizes()
    expect(children).toBeLessThanOrEqual(128)
    expect(settledTurns).toBeLessThanOrEqual(256)
  })

  it('keeps every running child past the settled-history bound', () => {
    const executions = new CodexSubagentExecutions()
    for (let index = 0; index < 200; index++) {
      expect(executions.observeTurn(`child-${index}`, `turn-${index}`, 'working')).not.toBeNull()
      executions.register(`child-${index}`, `child-${index}`)
    }
    expect(executions.workingChildren()).toHaveLength(200)
    executions.observeTurn('child-0', 'turn-0', 'completed')
    executions.register('next', 'next')
    expect(executions.find('child-0')).toBeUndefined()
    expect(executions.workingChildren()).toHaveLength(199)
  })

  it('evicts a child that ended before one announced but not yet started, which keeps its spawner', () => {
    const executions = new CodexSubagentExecutions()
    executions.register('announced', 'announced', 'spawner')
    for (let index = 0; index < 127; index++) {
      executions.observeTurn(`child-${index}`, `turn-${index}`, 'working')
    }
    executions.observeTurn('child-5', 'turn-5', 'completed')
    executions.register('next', 'next')
    expect(executions.find('child-5')).toBeUndefined()
    expect(executions.find('announced')).toMatchObject({
      registered: true,
      spawnerThreadId: 'spawner'
    })
    executions.observeTurn('announced', 'turn-a', 'working')
    expect(executions.workingChildren().map((child) => child.agentThreadId)).toContain('announced')
  })

  it('past the bound, evicts the oldest never-started child once no child has ended', () => {
    const executions = new CodexSubagentExecutions()
    for (let index = 0; index < 200; index++) {
      executions.register(`restored-${index}`, `restored-${index}`)
    }
    expect(executions.retentionSizes().children).toBe(128)
    expect(executions.find('restored-0')).toBeUndefined()
    expect(executions.find('restored-199')).toBeDefined()
  })

  it('collapses a label’s whitespace, and keeps the first label a child was given', () => {
    const executions = new CodexSubagentExecutions()
    executions.register('child', '  audit \n  the build ')
    executions.register('child', 'later name')
    executions.register('blank', '   ')
    expect(executions.label('child')).toBe('audit the build')
    expect(executions.label('blank')).toBeNull()
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
