import { describe, expect, it } from 'vitest'
import { buildDispatchPreamble } from './worker-dispatch-preamble'

function preamble(): string {
  return buildDispatchPreamble({
    taskId: 'task_1',
    dispatchId: 'dispatch_1',
    taskSpec: 'Do the task.',
    coordinatorHandle: 'term_coordinator',
    workerHandle: 'term_worker'
  })
}

function instructions(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*# ?/, ''))
    .join(' ')
}

describe('buildDispatchPreamble', () => {
  it('names only the worker terminal handle, not the coordinator one (#14570)', () => {
    const text = buildDispatchPreamble({
      taskId: 'task_1',
      dispatchId: 'disp_1',
      taskSpec: 'do the task',
      coordinatorHandle: 'term_coordinator',
      workerHandle: 'term_worker'
    })
    expect(text).toContain('orchestration ask --from term_worker')
    expect(text).not.toContain('term_coordinator')
  })

  it('does not tell an unfinished worker to settle the task as failed (#45187)', () => {
    const text = instructions(preamble())
    expect(text).not.toContain('if the work is not done')
    expect(text).toContain(
      'If work remains and nothing blocks you, keep working; do not report it as failed.'
    )
    expect(text).toContain(
      'Use --outcome failed only when you tried and the task cannot be completed, and say why.'
    )
    expect(text).toContain('--type worker_done')
    expect(text).toContain('--outcome succeeded')
    expect(text).toContain('--type escalation')
  })
})
