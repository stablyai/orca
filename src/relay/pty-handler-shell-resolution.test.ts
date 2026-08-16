import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as gitBash from '../main/git-bash'
import * as ptyShellUtils from './pty-shell-utils'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    // Why: attach now proves the backing pid is alive before replaying, so the
    // default managed PTY must report a live pid. Reuse the test runner's own
    // pid — always alive — so unrelated attach tests are not seen as dead.
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))

vi.mock('node-pty', () => ({
  spawn: mockPtySpawn
}))

vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

import type { PtyHandler } from './pty-handler'
import { beginPtyHandlerTest, endPtyHandlerTest } from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'

describe('PtyHandler', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  it('uses an explicit shell override and falls back to the default shell otherwise', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    const resolveDefaultShellSpy = vi
      .spyOn(ptyShellUtils, 'resolveDefaultShell')
      .mockReturnValue('/default-shell')
    try {
      await dispatcher.callRequest('pty.spawn', {
        cols: 80,
        rows: 24,
        shellOverride: 'powershell.exe'
      })
      expect(mockPtySpawn).toHaveBeenCalledWith(
        'powershell.exe',
        expect.any(Array),
        expect.any(Object)
      )

      mockPtySpawn.mockClear()

      await dispatcher.callRequest('pty.spawn', { cols: 80, rows: 24 })
      expect(mockPtySpawn).toHaveBeenCalledWith(
        '/default-shell',
        expect.any(Array),
        expect.any(Object)
      )
    } finally {
      resolveDefaultShellSpy.mockRestore()
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('ignores Windows shell overrides on non-Windows relay hosts', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'linux'
    })
    const resolveDefaultShellSpy = vi
      .spyOn(ptyShellUtils, 'resolveDefaultShell')
      .mockReturnValue('/default-shell')
    try {
      await dispatcher.callRequest('pty.spawn', {
        cols: 80,
        rows: 24,
        shellOverride: 'powershell.exe'
      })

      expect(mockPtySpawn).toHaveBeenCalledWith(
        '/default-shell',
        expect.any(Array),
        expect.any(Object)
      )
    } finally {
      resolveDefaultShellSpy.mockRestore()
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('rejects unsupported shell overrides on Windows relay hosts', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    try {
      await expect(
        dispatcher.callRequest('pty.spawn', {
          cols: 80,
          rows: 24,
          shellOverride: 'notepad.exe'
        })
      ).rejects.toThrow('Unsupported Windows shell override')
      expect(mockPtySpawn).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  // Why: both spellings classify as a POSIX startup family, so the relay must not be the one host
  // that hard-fails a setting the local and daemon PTYs accept.
  it.each(['bash', 'bash.exe'])(
    'accepts the %s shell override and routes it through Git Bash resolution',
    async (shellOverride) => {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'win32'
      })
      const resolveGitBashSpy = vi
        .spyOn(gitBash, 'resolveWindowsGitBashShellPath')
        .mockReturnValue('C:\\Program Files\\Git\\bin\\bash.exe')
      try {
        await dispatcher.callRequest('pty.spawn', { cols: 80, rows: 24, shellOverride })

        expect(resolveGitBashSpy).toHaveBeenCalledWith(shellOverride)
        expect(mockPtySpawn).toHaveBeenCalledWith(
          'C:\\Program Files\\Git\\bin\\bash.exe',
          expect.any(Array),
          expect.any(Object)
        )
      } finally {
        resolveGitBashSpy.mockRestore()
        Object.defineProperty(process, 'platform', {
          configurable: true,
          value: originalPlatform
        })
      }
    }
  )

  it('falls back to the literal bash override when Git Bash is not installed', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    const resolveGitBashSpy = vi
      .spyOn(gitBash, 'resolveWindowsGitBashShellPath')
      .mockReturnValue(null)
    try {
      await dispatcher.callRequest('pty.spawn', { cols: 80, rows: 24, shellOverride: 'bash' })

      expect(mockPtySpawn).toHaveBeenCalledWith('bash', expect.any(Array), expect.any(Object))
    } finally {
      resolveGitBashSpy.mockRestore()
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('resolves the Git Bash sentinel to the remote bash.exe path on Windows', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    const resolveGitBashSpy = vi
      .spyOn(gitBash, 'resolveWindowsGitBashShellPath')
      .mockReturnValue('C:\\Program Files\\Git\\bin\\bash.exe')
    try {
      await dispatcher.callRequest('pty.spawn', {
        cols: 80,
        rows: 24,
        shellOverride: 'git-bash'
      })

      expect(resolveGitBashSpy).toHaveBeenCalledWith('git-bash')
      expect(mockPtySpawn).toHaveBeenCalledWith(
        'C:\\Program Files\\Git\\bin\\bash.exe',
        expect.any(Array),
        expect.any(Object)
      )
    } finally {
      resolveGitBashSpy.mockRestore()
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('passes the selected WSL distro to relay launches on Windows', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    try {
      await dispatcher.callRequest('pty.spawn', {
        cols: 80,
        rows: 24,
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: 'Ubuntu-24.04'
      })

      expect(mockPtySpawn).toHaveBeenCalledWith(
        'wsl.exe',
        ['-d', 'Ubuntu-24.04'],
        expect.any(Object)
      )
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })
})
