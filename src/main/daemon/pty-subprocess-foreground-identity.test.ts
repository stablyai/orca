// Foreground process reporting: node-pty names, agent enrichment and its cache.
import { describe, expect, it, vi } from 'vitest'
import type * as LocalPtyUtils from '../providers/local-pty-utils'

const {
  spawnMock,
  isPwshAvailableMock,
  validateWorkingDirectoryMock,
  resolveUnixShellPathMock,
  resolveAgentForegroundProcessMock
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  isPwshAvailableMock: vi.fn(),
  resolveUnixShellPathMock: vi.fn((shellPath: string) => shellPath),
  resolveAgentForegroundProcessMock: vi.fn(),
  validateWorkingDirectoryMock: vi.fn((cwd: string) => {
    if (cwd.includes('definitely-missing')) {
      throw new Error(
        `Working directory "${cwd}" does not exist. It may have been deleted or is on an unmounted volume.`
      )
    }
  })
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock
}))

vi.mock('../pwsh', () => ({
  isPwshAvailable: isPwshAvailableMock
}))

// Resolve PowerShell family names to deterministic absolute paths so these
// tests run on non-Windows CI. The real resolver (which skips the Store App
// Execution Alias stub) is exercised in windows-powershell-executable.test.ts.
const PWSH7_ABS = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const WINDOWS_POWERSHELL_ABS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const CMD_ABS = 'C:\\Windows\\System32\\cmd.exe'
vi.mock('../providers/windows-powershell-executable', () => ({
  resolveWindowsPowerShellExecutablePath: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe' ? PWSH7_ABS : WINDOWS_POWERSHELL_ABS,
  resolveWindowsPowerShellSpawnChain: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe'
      ? [PWSH7_ABS, WINDOWS_POWERSHELL_ABS, CMD_ABS]
      : [WINDOWS_POWERSHELL_ABS, CMD_ABS],
  getWindowsCmdPath: () => CMD_ABS
}))

vi.mock('../providers/local-pty-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof LocalPtyUtils>()
  return {
    ...actual,
    resolveUnixShellPath: resolveUnixShellPathMock,
    validateWorkingDirectory: validateWorkingDirectoryMock,
    validateWorkingDirectoryAsync: validateWorkingDirectoryMock
  }
})

vi.mock('../providers/agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: async (...args: unknown[]) => {
    const value = await resolveAgentForegroundProcessMock(...args)
    return value && typeof value === 'object' && 'available' in value
      ? value
      : { available: true, processName: value }
  }
}))

// Console-membership reads run a real node-pty fork that never settles under
// fake timers; default to "shell-only" so the degraded-scan guard falls through
// to its existing retirement logic (the degraded-scan behavior itself is
// covered in pty-subprocess-foreground-degraded-scan.test.ts).
vi.mock('../providers/windows-pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: () => new Set([12345]),
  isWindowsPtyJobReadable: () => true
}))

import { createPtySubprocess } from './pty-subprocess'
import { mockPtyProcess, useDaemonPtySubprocessEnv } from './pty-subprocess-test-harness'

describe('createPtySubprocess', () => {
  useDaemonPtySubprocessEnv({
    spawnMock,
    isPwshAvailableMock,
    resolveUnixShellPathMock,
    resolveAgentForegroundProcessMock,
    validateWorkingDirectoryMock
  })

  it('normalizes foreground process names from node-pty', async () => {
    const proc = mockPtyProcess()
    proc.process = '/opt/homebrew/bin/codex'
    spawnMock.mockReturnValue(proc)

    const handle = await createPtySubprocess({
      sessionId: 'test',
      cols: 80,
      rows: 24
    })

    expect(handle.getForegroundProcess()).toBe('codex')
  })

  it('serves daemon wrapper agent foreground from an async cache without blocking', async () => {
    const proc = mockPtyProcess()
    proc.process = 'node'
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    let resolveForeground!: (processName: string) => void
    resolveAgentForegroundProcessMock.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveForeground = resolve
      })
    )

    try {
      const handle = await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24
      })

      expect(handle.getForegroundProcess()).toBe('node')
      expect(resolveAgentForegroundProcessMock).toHaveBeenCalledWith(
        proc.pid,
        'node',
        expect.any(Object)
      )

      resolveForeground('codex')
      await vi.waitFor(() => expect(handle.getForegroundProcess()).toBe('codex'))
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('serves the resolved agent identity past the cache TTL while a wrapper holds the foreground', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-16T12:00:00.000Z'))
    const proc = mockPtyProcess()
    proc.process = 'node'
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    resolveAgentForegroundProcessMock.mockResolvedValue('grok')

    try {
      const handle = await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24
      })

      expect(handle.getForegroundProcess()).toBe('node')
      await Promise.resolve()
      await Promise.resolve()
      expect(handle.getForegroundProcess()).toBe('grok')

      // Why: renderer reads poll slower than the 1s cache TTL — an expired
      // cache must keep answering with the resolved identity, not the wrapper.
      vi.advanceTimersByTime(1_500)
      expect(handle.getForegroundProcess()).toBe('grok')
    } finally {
      vi.useRealTimers()
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('clears an expired identity when the wrapper tree no longer resolves to an agent', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-16T12:00:00.000Z'))
    const proc = mockPtyProcess()
    proc.process = 'node'
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    resolveAgentForegroundProcessMock.mockResolvedValueOnce('grok').mockResolvedValue('node')

    try {
      const handle = await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24
      })

      expect(handle.getForegroundProcess()).toBe('node')
      await Promise.resolve()
      await Promise.resolve()
      expect(handle.getForegroundProcess()).toBe('grok')
      // Flush the first refresh's finally so the next read can revalidate.
      await Promise.resolve()
      await Promise.resolve()

      // An unrelated wrapper (e.g. npm) now owns the pane: the stale-served
      // identity is revalidated and dropped once the refresh finds no agent.
      vi.advanceTimersByTime(1_500)
      expect(handle.getForegroundProcess()).toBe('grok')
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(handle.getForegroundProcess()).toBe('node')
    } finally {
      vi.useRealTimers()
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('serves daemon Windows wrapper agent foreground from an async cache', async () => {
    const proc = mockPtyProcess()
    proc.process = 'node.exe'
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    let resolveForeground!: (processName: string) => void
    resolveAgentForegroundProcessMock.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveForeground = resolve
      })
    )

    try {
      const handle = await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24
      })

      expect(handle.getForegroundProcess()).toBe('node.exe')
      expect(resolveAgentForegroundProcessMock).toHaveBeenCalledWith(
        proc.pid,
        'node.exe',
        expect.any(Object)
      )

      resolveForeground('codex')
      await vi.waitFor(() => expect(handle.getForegroundProcess()).toBe('codex'))
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('serves daemon shell-rooted agent foreground from an async cache', async () => {
    const proc = mockPtyProcess()
    proc.process = 'powershell.exe'
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    let resolveForeground!: (processName: string) => void
    resolveAgentForegroundProcessMock.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveForeground = resolve
      })
    )

    try {
      const handle = await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24
      })

      expect(handle.getForegroundProcess()).toBe('powershell.exe')
      expect(resolveAgentForegroundProcessMock).toHaveBeenCalledWith(
        proc.pid,
        'powershell.exe',
        expect.any(Object)
      )

      resolveForeground('codex')
      await vi.waitFor(() => expect(handle.getForegroundProcess()).toBe('codex'))
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('preserves the ordinary fallback when Windows process enumeration is unavailable', async () => {
    const proc = mockPtyProcess()
    proc.process = 'powershell.exe'
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    resolveAgentForegroundProcessMock.mockResolvedValue({
      available: false,
      processName: 'powershell.exe'
    })

    try {
      const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })

      expect(handle.getForegroundProcess()).toBe('powershell.exe')
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(handle.getForegroundProcess()).toBe('powershell.exe')
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('awaits a fresh delayed Windows scan instead of serving the shell fallback', async () => {
    const proc = mockPtyProcess()
    proc.process = 'powershell.exe'
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    let resolveFresh!: (processName: string) => void
    resolveAgentForegroundProcessMock.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveFresh = resolve
      })
    )

    try {
      const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
      const confirmation = handle.confirmForegroundProcess!()
      let settled = false
      void confirmation.then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)

      resolveFresh('droid')
      await expect(confirmation).resolves.toBe('droid')
      expect(resolveAgentForegroundProcessMock).toHaveBeenCalledExactlyOnceWith(
        proc.pid,
        'powershell.exe',
        expect.objectContaining({ fresh: true, forceProcessScan: true })
      )
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('returns null when a fresh Windows confirmation scan is unavailable', async () => {
    const proc = mockPtyProcess()
    proc.process = 'powershell.exe'
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    resolveAgentForegroundProcessMock.mockResolvedValue({
      available: false,
      processName: 'powershell.exe'
    })

    try {
      const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
      await expect(handle.confirmForegroundProcess!()).resolves.toBeNull()
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('returns null when a recognized Windows fallback disappears during confirmation', async () => {
    const proc = mockPtyProcess()
    proc.process = 'droid'
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    resolveAgentForegroundProcessMock.mockResolvedValue({
      available: true,
      processName: null
    })

    try {
      const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
      await expect(handle.confirmForegroundProcess!()).resolves.toBeNull()
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('serves Unix agent foreground when node-pty reports an agent child process', async () => {
    const proc = mockPtyProcess()
    proc.process = 'uv'
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    let resolveForeground!: (processName: string) => void
    resolveAgentForegroundProcessMock.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveForeground = resolve
      })
    )

    try {
      const handle = await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24
      })

      expect(handle.getForegroundProcess()).toBe('uv')
      expect(resolveAgentForegroundProcessMock).toHaveBeenCalledWith(
        proc.pid,
        'uv',
        expect.any(Object)
      )

      resolveForeground('claude')
      await vi.waitFor(() => expect(handle.getForegroundProcess()).toBe('claude'))
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('does not let stale shell enrichment clear a newer direct agent foreground cache', async () => {
    const proc = mockPtyProcess()
    proc.process = 'powershell.exe'
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    let resolveForeground!: (processName: string) => void
    resolveAgentForegroundProcessMock.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveForeground = resolve
      })
    )

    try {
      const handle = await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24
      })

      expect(handle.getForegroundProcess()).toBe('powershell.exe')
      proc.process = 'codex'
      expect(handle.getForegroundProcess()).toBe('codex')

      resolveForeground('powershell.exe')
      await Promise.resolve()
      await Promise.resolve()

      proc.process = 'powershell.exe'
      expect(handle.getForegroundProcess()).toBe('codex')
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('keeps menu startup agent foreground through early negative shell enrichment', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-16T12:00:00.000Z'))
    const proc = mockPtyProcess()
    proc.process = 'powershell.exe'
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    resolveAgentForegroundProcessMock.mockResolvedValue('powershell.exe')

    try {
      const handle = await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd: 'C:\\repo\\orca',
        command: 'codex'
      })

      expect(handle.getForegroundProcess()).toBe('codex')
      expect(resolveAgentForegroundProcessMock).toHaveBeenCalledWith(
        proc.pid,
        'powershell.exe',
        expect.any(Object)
      )

      await Promise.resolve()
      expect(handle.getForegroundProcess()).toBe('codex')

      vi.advanceTimersByTime(4_999)
      expect(handle.getForegroundProcess()).toBe('codex')

      vi.advanceTimersByTime(2)
      expect(handle.getForegroundProcess()).toBe('powershell.exe')
    } finally {
      vi.useRealTimers()
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('keeps menu startup agent foreground during a slow Windows shell enrichment window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-16T12:00:00.000Z'))
    const proc = mockPtyProcess()
    proc.process = 'powershell.exe'
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    let resolveForeground!: (processName: string) => void
    resolveAgentForegroundProcessMock.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveForeground = resolve
      })
    )

    try {
      const handle = await createPtySubprocess({
        sessionId: 'repo::C:\\repo\\orca@@deadbeef',
        cols: 80,
        rows: 24,
        cwd: 'C:\\repo\\orca',
        command: 'codex'
      })

      expect(handle.getForegroundProcess()).toBe('codex')
      expect(resolveAgentForegroundProcessMock).toHaveBeenCalledWith(
        proc.pid,
        'powershell.exe',
        expect.objectContaining({
          contextPaths: expect.arrayContaining(['C:\\repo\\orca'])
        })
      )

      vi.advanceTimersByTime(2_500)
      expect(handle.getForegroundProcess()).toBe('codex')

      resolveForeground('powershell.exe')
      await vi.runAllTimersAsync()
    } finally {
      vi.useRealTimers()
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('uses the spawned Windows shell when node-pty reports only the terminal name', async () => {
    const proc = mockPtyProcess()
    proc.process = 'xterm-256color'
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    resolveAgentForegroundProcessMock.mockResolvedValue('codex')

    try {
      const handle = await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        shellOverride: 'powershell.exe'
      })

      expect(handle.getForegroundProcess()).toBe('powershell.exe')
      expect(resolveAgentForegroundProcessMock).toHaveBeenCalledWith(
        proc.pid,
        'powershell.exe',
        expect.any(Object)
      )

      await vi.waitFor(() => expect(handle.getForegroundProcess()).toBe('codex'))
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('does not schedule foreground enrichment for arbitrary Windows TUIs', async () => {
    const proc = mockPtyProcess()
    proc.process = 'vim.exe'
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })

    try {
      const handle = await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24
      })

      expect(handle.getForegroundProcess()).toBe('vim.exe')
      expect(resolveAgentForegroundProcessMock).not.toHaveBeenCalled()
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('treats node-pty terminal name as inconclusive foreground process', async () => {
    const proc = mockPtyProcess()
    proc.process = 'xterm-256color'
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })

    try {
      const handle = await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24
      })

      expect(handle.getForegroundProcess()).toBeNull()
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })
})
