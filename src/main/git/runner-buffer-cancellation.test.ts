import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: vi.fn(),
  spawn: vi.fn()
}))

import { gitExecFileAsyncBuffer } from './runner'
import {
  GitAdmissionScheduler,
  _resetGitAdmissionForTests
} from './command-runner/git-subprocess-admission'
import { configureWindowsHostGitEnvironmentReadiness } from './command-runner/windows-host-git-environment'

beforeEach(() => execFileMock.mockReset())
afterEach(() => {
  _resetGitAdmissionForTests()
  configureWindowsHostGitEnvironmentReadiness(null)
})

describe('buffered Git cancellation', () => {
  it('rejects an already canceled read without launching Git', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      gitExecFileAsyncBuffer(['show', 'HEAD:file'], { cwd: '/repo', signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('removes a canceled queued read without waiting for the active child', async () => {
    const scheduler = new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 0 })
    _resetGitAdmissionForTests(scheduler)
    const grant = await scheduler.acquire({ args: ['show'], cwd: '/repo' })
    try {
      const controller = new AbortController()
      const read = gitExecFileAsyncBuffer(['show', 'HEAD:file'], {
        cwd: '/repo',
        signal: controller.signal
      })
      const rejected = expect(read).rejects.toMatchObject({ name: 'AbortError' })
      await vi.waitFor(() => expect(scheduler.snapshot().queued).toBe(1))
      controller.abort()
      await rejected
      expect(scheduler.snapshot().queued).toBe(0)
      expect(execFileMock).not.toHaveBeenCalled()
    } finally {
      grant.release()
    }
  })

  it('kills an active child while retaining its admission slot until close', async () => {
    const scheduler = new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 0 })
    _resetGitAdmissionForTests(scheduler)
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn()
    })
    execFileMock.mockReturnValue(child)
    const controller = new AbortController()
    const read = gitExecFileAsyncBuffer(['show', 'HEAD:file'], {
      cwd: '/repo',
      signal: controller.signal
    })
    const rejected = expect(read).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledOnce())
    controller.abort()
    await rejected
    expect(child.kill).toHaveBeenCalledOnce()
    expect(scheduler.snapshot().budgets.general.baseUsed).toBe(1)
    child.emit('close', 0)
    await vi.waitFor(() => expect(scheduler.snapshot().budgets.general.baseUsed).toBe(0))
  })

  it('cancels Windows environment readiness without launching Git', async () => {
    const platform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      configureWindowsHostGitEnvironmentReadiness(() => new Promise(() => {}))
      const controller = new AbortController()
      const read = gitExecFileAsyncBuffer(['show', 'HEAD:file'], {
        cwd: String.raw`C:\repo`,
        signal: controller.signal
      })
      const rejected = expect(read).rejects.toMatchObject({ name: 'AbortError' })
      controller.abort()
      await rejected
      expect(execFileMock).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: platform })
    }
  })
})
