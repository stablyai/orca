import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitSpawnMock, killSpawnedCommandTreeMock } = vi.hoisted(() => ({
  gitSpawnMock: vi.fn(),
  killSpawnedCommandTreeMock: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./git-spawn', () => ({ gitSpawn: gitSpawnMock }))
vi.mock('./spawned-command-tree-kill', () => ({
  killSpawnedCommandTree: killSpawnedCommandTreeMock
}))

import { gitStreamStdout } from './git-stream-stdout'
import {
  GitAdmissionScheduler,
  _gitAdmissionSnapshotForTests,
  _resetGitAdmissionForTests
} from './git-subprocess-admission'

function mockChild(): ChildProcess {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  child.pid = 1234
  child.kill = vi.fn(() => true)
  child.stdin = null
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child as unknown as ChildProcess
}

describe('git stream admission lifetime', () => {
  beforeEach(() => {
    gitSpawnMock.mockReset()
    killSpawnedCommandTreeMock.mockClear()
    _resetGitAdmissionForTests(new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 1 }))
  })

  afterEach(() => _resetGitAdmissionForTests())

  it('retains the permit after maxBuffer settlement until close', async () => {
    const child = mockChild()
    gitSpawnMock.mockReturnValue(child)
    const pending = gitStreamStdout(['status'], {
      cwd: '/repo',
      maxBuffer: 1,
      onStdout: () => {}
    })
    await vi.waitFor(() => expect(gitSpawnMock).toHaveBeenCalledOnce())

    child.stdout?.emit('data', Buffer.from('xx'))
    await expect(pending).rejects.toThrow('maxBuffer')
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(1)

    child.emit('close', null, 'SIGKILL')
    await Promise.resolve()
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(0)
  })

  it('retains the permit after abort settlement until close', async () => {
    const child = mockChild()
    const controller = new AbortController()
    gitSpawnMock.mockReturnValue(child)
    const pending = gitStreamStdout(['status'], {
      cwd: '/repo',
      signal: controller.signal,
      onStdout: () => {}
    })
    await vi.waitFor(() => expect(gitSpawnMock).toHaveBeenCalledOnce())

    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(1)

    child.emit('close', null, 'SIGKILL')
    await Promise.resolve()
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(0)
  })
})
