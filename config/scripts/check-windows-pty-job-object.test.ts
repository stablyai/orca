import { describe, expect, it, vi } from 'vitest'
import {
  runWindowsPtyJobObjectCheck,
  WINDOWS_PTY_JOB_OBJECT_TESTS
} from './check-windows-pty-job-object.mjs'

describe('Windows PTY Job Object check wrapper', () => {
  it('runs focused tests before the native evidence probe', () => {
    const run = vi.fn(() => ({ status: 0 }))
    runWindowsPtyJobObjectCheck('evidence.json', run)
    expect(run).toHaveBeenNthCalledWith(
      1,
      'pnpm',
      ['exec', 'vitest', 'run', ...WINDOWS_PTY_JOB_OBJECT_TESTS],
      expect.any(Object)
    )
    expect(run).toHaveBeenNthCalledWith(
      2,
      process.execPath,
      ['config/scripts/run-windows-pty-job-object-probe.mjs', '--evidence', 'evidence.json'],
      expect.any(Object)
    )
  })

  it('does not manufacture evidence after a focused test failure', () => {
    const run = vi.fn(() => ({ status: 1 }))
    expect(() => runWindowsPtyJobObjectCheck('evidence.json', run)).toThrow('tests failed')
    expect(run).toHaveBeenCalledTimes(1)
  })
})
