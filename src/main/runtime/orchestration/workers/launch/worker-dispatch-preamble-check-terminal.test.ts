import { describe, expect, it } from 'vitest'
import { buildDispatchPreamble } from './worker-dispatch-preamble'

function cliFence(checkNamesTerminal?: boolean): string {
  const preamble = buildDispatchPreamble({
    taskId: 'task_abc123',
    dispatchId: 'ctx_def456',
    taskSpec: 'Implement the login form',
    coordinatorHandle: 'term_coord',
    workerHandle: 'term_worker',
    ...(checkNamesTerminal ? { checkNamesTerminal } : {})
  })
  const match = preamble.match(/=== CLI COMMANDS ===\n\n```sh\n([\s\S]*?)\n```/)
  expect(match).not.toBeNull()
  return match?.[1] ?? ''
}

describe('a worker whose tools run without ORCA_TERMINAL_HANDLE', () => {
  it('is told to name its terminal when it checks mail', () => {
    expect(cliFence(true)).toContain('orca orchestration check --terminal term_worker')
  })

  it('leaves other workers without a check line until mail is waiting', () => {
    expect(cliFence()).not.toContain('orchestration check')
  })
})
