import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: vi.fn(),
  spawn: vi.fn()
}))

import { gitExecFileAsyncBuffer } from './command-runner/git-exec-file'

import { _resetGitAdmissionForTests } from './command-runner/admission/git-subprocess-admission'
import { configureWindowsHostGitEnvironmentReadiness } from './command-runner/host-routing/windows-host-git-environment'

beforeEach(() => execFileMock.mockReset())
afterEach(() => {
  _resetGitAdmissionForTests()
  configureWindowsHostGitEnvironmentReadiness(null)
})

describe('buffered Git cancellation', () => {
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
