import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  execFile: execFileMock
}))

import { gitExecFileAsync } from './git-exec-file'
import {
  GitAdmissionScheduler,
  _gitAdmissionSnapshotForTests,
  _resetGitAdmissionForTests
} from './git-subprocess-admission'

function mockChild(pid: number): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    pid,
    kill: vi.fn(() => true),
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
    stdout: new EventEmitter(),
    stderr: new EventEmitter()
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the exec wrapper only reads pid, kill, stdio and events.
  return child as unknown as ChildProcess
}

describe('worktree deletes and general git admission', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    execFileMock.mockReset()
    // The smallest general cap a host can have: deletes holding it would stall every status read.
    _resetGitAdmissionForTests(new GitAdmissionScheduler({ generalCap: 2, generalHeadroom: 0 }))
  })

  afterEach(() => {
    vi.useRealTimers()
    _resetGitAdmissionForTests()
  })

  it('runs a status read while deletes that fill the general cap are still running', async () => {
    let pid = 100
    execFileMock.mockImplementation(() => mockChild(pid++))

    for (const path of ['/wt-a', '/wt-b', '/wt-c']) {
      void gitExecFileAsync(['worktree', 'remove', path], { cwd: '/repo', admissionExempt: true })
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(execFileMock).toHaveBeenCalledTimes(3)
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed ?? 0).toBe(0)

    void gitExecFileAsync(['status', '--porcelain'], { cwd: '/repo' })
    await vi.advanceTimersByTimeAsync(0)

    expect(execFileMock).toHaveBeenCalledTimes(4)
    expect(execFileMock.mock.calls[3]?.[1]).toContain('status')
    expect(_gitAdmissionSnapshotForTests().queued).toBe(0)
  })
})
