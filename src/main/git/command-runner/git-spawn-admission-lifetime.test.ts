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

  it('releases a normally closed child exactly once', async () => {
    const child = mockChild()
    await withGitAdmission(['status'], { cwd: '/repo' }, () => child)

    child.emit('close', 0, null)
    child.emit('close', 0, null)
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(0)
  })

  it('retains an early-killed child until eventual close', async () => {
    const child = mockChild()
    await withGitAdmission(['status'], { cwd: '/repo' }, () => child)

    child.kill()
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(1)
    child.emit('close', null, 'SIGTERM')
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(0)
  })

  it('retains a live child error until eventual close and releases once', async () => {
    const child = mockChild()
    await withGitAdmission(['status'], { cwd: '/repo' }, () => child)
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(1)

    child.emit('error', new Error('kill delivery failed'))
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(1)
    child.emit('close', null, 'SIGKILL')
    child.emit('close', null, 'SIGKILL')

    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(0)
  })

  it('releases a no-PID spawn error without waiting for close', async () => {
    const child = mockChild(0)
    await withGitAdmission(['status'], { cwd: '/repo' }, () => child)
    child.emit('error', new Error('ENOENT'))

    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(0)
  })

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
