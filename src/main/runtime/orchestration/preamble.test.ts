import { describe, expect, it } from 'vitest'
import { buildDispatchPreamble } from './preamble'

describe('buildDispatchPreamble', () => {
  it('substitutes template variables', () => {
    const result = buildDispatchPreamble({
      taskId: 'task_abc123',
      taskSpec: 'Implement the login form',
      coordinatorHandle: 'term_coord'
    })

    expect(result).toContain('task_abc123')
    expect(result).toContain('term_coord')
    expect(result).toContain('Implement the login form')
    expect(result).not.toContain('{{')
  })

  it('includes worker_done command', () => {
    const result = buildDispatchPreamble({
      taskId: 'task_x',
      taskSpec: 'do stuff',
      coordinatorHandle: 'term_c'
    })

    expect(result).toContain('worker_done')
    expect(result).toContain('orchestration send')
    expect(result).toContain('orchestration check')
  })

  it('includes the task spec after separator', () => {
    const result = buildDispatchPreamble({
      taskId: 'task_x',
      taskSpec: 'refactor the auth module',
      coordinatorHandle: 'term_c'
    })

    expect(result).toContain('--- TASK ---')
    expect(result).toContain('refactor the auth module')
  })

  it('uses orca CLI by default when devMode is not set', () => {
    const result = buildDispatchPreamble({
      taskId: 'task_x',
      taskSpec: 'do stuff',
      coordinatorHandle: 'term_c'
    })

    expect(result).toContain('orca orchestration send')
    expect(result).toContain('orca orchestration check')
  })

  it('uses orca-dev CLI when devMode is true', () => {
    const result = buildDispatchPreamble({
      taskId: 'task_x',
      taskSpec: 'do stuff',
      coordinatorHandle: 'term_c',
      devMode: true
    })

    expect(result).toContain('orca-dev orchestration send')
    expect(result).toContain('orca-dev orchestration check')
    // Ensure no bare "orca " (without -dev) appears as a CLI command.
    // We split on "orca-dev" first so those occurrences don't produce
    // false positives, then check the remaining fragments.
    const fragments = result.split('orca-dev')
    for (const fragment of fragments) {
      expect(fragment).not.toMatch(/orca orchestration/)
    }
  })

  it('uses orca CLI when devMode is false', () => {
    const result = buildDispatchPreamble({
      taskId: 'task_x',
      taskSpec: 'do stuff',
      coordinatorHandle: 'term_c',
      devMode: false
    })

    expect(result).toContain('orca orchestration send')
    expect(result).toContain('orca orchestration check')
  })
})
