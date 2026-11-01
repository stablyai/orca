import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withGitAdmission } from './git-spawn'
import {
  GitAdmissionScheduler,
  _gitAdmissionSnapshotForTests,
  _resetGitAdmissionForTests
} from './git-subprocess-admission'

function mockChild(pid: number | undefined = 1234): ChildProcess {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  child.pid = pid
  child.kill = vi.fn(() => true)
  return child as unknown as ChildProcess
}

describe('git spawn admission lifetime', () => {
  beforeEach(() => {
    _resetGitAdmissionForTests(new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 1 }))
  })

  afterEach(() => _resetGitAdmissionForTests())

  it('aborts while queued without releasing the running child', async () => {
    const scheduler = new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 0 })
    _resetGitAdmissionForTests(scheduler)
    const running = await scheduler.acquire({ args: ['status'], cwd: '/repo' })
    const controller = new AbortController()
    const pending = withGitAdmission(['status'], { cwd: '/repo', signal: controller.signal }, () =>
      mockChild()
    )
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(1)
    running.release()
  })
})
