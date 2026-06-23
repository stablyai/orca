/* oxlint-disable max-lines -- Why: exercises full PTY subprocess surface (spawn setup, signal routing, data events, platform-specific shell configs, and Windows PowerShell implementations) with co-located test scenarios to prevent fixture drift. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type * as LocalPtyUtils from '../providers/local-pty-utils'

const {
  spawnMock,
  isPwshAvailableMock,
  validateWorkingDirectoryMock,
  resolveAgentForegroundProcessMock
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  isPwshAvailableMock: vi.fn(),
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

vi.mock('../providers/local-pty-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof LocalPtyUtils>()
  return {
    ...actual,
    validateWorkingDirectory: validateWorkingDirectoryMock
  }
})

vi.mock('../providers/agent-foreground-process', () => ({
  resolveAgentForegroundProcess: resolveAgentForegroundProcessMock
}))

import { createPtySubprocess } from './pty-subprocess'

const ORCA_SHELL_WRAPPER_ENV = [
  'ORCA_ATTRIBUTION_SHIM_DIR',
  'ORCA_OPENCODE_CONFIG_DIR',
  'ORCA_PI_CODING_AGENT_DIR',
  'ORCA_OMP_CODING_AGENT_DIR',
  'ORCA_CODEX_HOME'
] as const
const POWERSHELL_OSC133_COMMAND_ARGS = ['-NoLogo', '-NoExit', '-EncodedCommand', expect.any(String)]
const ZSH_SHELL_READY_DIR = /shell-ready[\\/]zsh/
const itOnMacHost = process.platform === 'darwin' ? it : it.skip

function mockPtyProcess(pid = 12345) {
  const onDataListeners: ((data: string) => void)[] = []
  const onExitListeners: ((e: { exitCode: number }) => void)[] = []
  return {
    pid,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    process: 'zsh',
    onData: vi.fn((cb: (data: string) => void) => {
      onDataListeners.push(cb)
      return { dispose: vi.fn() }
    }),
    onExit: vi.fn((cb: (e: { exitCode: number }) => void) => {
      onExitListeners.push(cb)
      return { dispose: vi.fn() }
    }),
    _simulateData: (data: string) => onDataListeners.forEach((cb) => cb(data)),
    _simulateExit: (code: number) => onExitListeners.forEach((cb) => cb({ exitCode: code }))
  }
}

describe('createPtySubprocess', () => {
  const savedWrapperEnv: Partial<Record<(typeof ORCA_SHELL_WRAPPER_ENV)[number], string>> = {}
  let previousUserDataPath: string | undefined
  let userDataPath: string

  beforeEach(() => {
    spawnMock.mockReset()
    isPwshAvailableMock.mockReset()
    resolveAgentForegroundProcessMock.mockReset()
    resolveAgentForegroundProcessMock.mockImplementation(
      async (_pid: number, fallbackProcess: string | null) => fallbackProcess
    )
    validateWorkingDirectoryMock.mockClear()
    isPwshAvailableMock.mockReturnValue(false)
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    userDataPath = mkdtempSync(join(tmpdir(), 'daemon-pty-subprocess-test-'))
    process.env.ORCA_USER_DATA_PATH = userDataPath
    for (const key of ORCA_SHELL_WRAPPER_ENV) {
      savedWrapperEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
    rmSync(userDataPath, { recursive: true, force: true })
    for (const key of ORCA_SHELL_WRAPPER_ENV) {
      if (savedWrapperEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = savedWrapperEnv[key]
      }
      delete savedWrapperEnv[key]
    }
  })
  it('spawns node-pty with correct options', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd: '/home/user',
        env: { SHELL: '/bin/bash', FOO: 'bar' }
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      '/bin/bash',
      expect.any(Array),
      expect.objectContaining({
        cols: 80,
        rows: 24,
        cwd: '/home/user',
        name: 'xterm-256color'
      })
    )
  })

  itOnMacHost('repairs a deleted macOS daemon cwd before spawning node-pty', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    const originalCwd = process.cwd()
    const deletedDaemonCwd = mkdtempSync(join(tmpdir(), 'orca-deleted-daemon-cwd-'))
    Object.defineProperty(process, 'platform', { value: 'darwin' })

    try {
      process.chdir(deletedDaemonCwd)
      rmSync(deletedDaemonCwd, { recursive: true, force: true })

      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd: originalCwd,
        env: { SHELL: '/bin/bash' }
      })

      expect(process.cwd()).toBe(realpathSync(userDataPath))
    } finally {
      process.chdir(originalCwd)
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      '/bin/bash',
      expect.any(Array),
      expect.objectContaining({ cwd: originalCwd })
    )
  })

  it('returns a SubprocessHandle with correct pid', () => {
    const proc = mockPtyProcess(42)
    spawnMock.mockReturnValue(proc)

    const handle = createPtySubprocess({
      sessionId: 'test',
      cols: 80,
      rows: 24
    })

    expect(handle.pid).toBe(42)
  })

  it('normalizes foreground process names from node-pty', () => {
    const proc = mockPtyProcess()
    proc.process = '/opt/homebrew/bin/codex'
    spawnMock.mockReturnValue(proc)

    const handle = createPtySubprocess({
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
      const handle = createPtySubprocess({
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
      const handle = createPtySubprocess({
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
      const handle = createPtySubprocess({
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
      const handle = createPtySubprocess({
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
      const handle = createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
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
      const handle = createPtySubprocess({
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
      const handle = createPtySubprocess({
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

  it('does not schedule foreground enrichment for arbitrary Windows TUIs', () => {
    const proc = mockPtyProcess()
    proc.process = 'vim.exe'
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })

    try {
      const handle = createPtySubprocess({
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

  it('treats node-pty terminal name as inconclusive foreground process', () => {
    const proc = mockPtyProcess()
    proc.process = 'xterm-256color'
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })

    try {
      const handle = createPtySubprocess({
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

  it('does not inherit parent Orca pane identity when caller omits pane env', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const saved = {
      ORCA_PANE_KEY: process.env.ORCA_PANE_KEY,
      ORCA_TAB_ID: process.env.ORCA_TAB_ID,
      ORCA_WORKTREE_ID: process.env.ORCA_WORKTREE_ID
    }
    process.env.ORCA_PANE_KEY = 'parent-tab:parent-leaf'
    process.env.ORCA_TAB_ID = 'parent-tab'
    process.env.ORCA_WORKTREE_ID = 'parent-worktree'

    try {
      createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }

    const env = spawnMock.mock.calls.at(-1)?.[2].env
    expect(env.ORCA_PANE_KEY).toBeUndefined()
    expect(env.ORCA_TAB_ID).toBeUndefined()
    expect(env.ORCA_WORKTREE_ID).toBeUndefined()
  })

  it('preserves explicit child Orca pane identity over parent env', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const saved = {
      ORCA_PANE_KEY: process.env.ORCA_PANE_KEY,
      ORCA_TAB_ID: process.env.ORCA_TAB_ID,
      ORCA_WORKTREE_ID: process.env.ORCA_WORKTREE_ID
    }
    process.env.ORCA_PANE_KEY = 'parent-tab:parent-leaf'
    process.env.ORCA_TAB_ID = 'parent-tab'
    process.env.ORCA_WORKTREE_ID = 'parent-worktree'

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        env: {
          ORCA_PANE_KEY: 'child-tab:child-leaf',
          ORCA_TAB_ID: 'child-tab',
          ORCA_WORKTREE_ID: 'child-worktree'
        }
      })
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }

    const env = spawnMock.mock.calls.at(-1)?.[2].env
    expect(env.ORCA_PANE_KEY).toBe('child-tab:child-leaf')
    expect(env.ORCA_TAB_ID).toBe('child-tab')
    expect(env.ORCA_WORKTREE_ID).toBe('child-worktree')
  })

  it('does not inherit ELECTRON_RUN_AS_NODE from the daemon process env', () => {
    // Why: the daemon is forked with ELECTRON_RUN_AS_NODE=1. If that flag
    // reaches user shells, nested Electron commands run as plain Node.
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const previous = process.env.ELECTRON_RUN_AS_NODE
    process.env.ELECTRON_RUN_AS_NODE = '1'

    try {
      createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    } finally {
      if (previous === undefined) {
        delete process.env.ELECTRON_RUN_AS_NODE
      } else {
        process.env.ELECTRON_RUN_AS_NODE = previous
      }
    }

    const env = spawnMock.mock.calls.at(-1)?.[2].env
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('does not inherit parent agent hook endpoint for development hook env', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const previousEndpoint = process.env.ORCA_AGENT_HOOK_ENDPOINT
    process.env.ORCA_AGENT_HOOK_ENDPOINT = '/tmp/stale-endpoint.env'

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        env: {
          ORCA_AGENT_HOOK_ENV: 'development',
          ORCA_AGENT_HOOK_PORT: '1234',
          ORCA_AGENT_HOOK_TOKEN: 'token',
          ORCA_AGENT_HOOK_VERSION: '1'
        }
      })
    } finally {
      if (previousEndpoint === undefined) {
        delete process.env.ORCA_AGENT_HOOK_ENDPOINT
      } else {
        process.env.ORCA_AGENT_HOOK_ENDPOINT = previousEndpoint
      }
    }

    const env = spawnMock.mock.calls.at(-1)?.[2].env
    expect(env.ORCA_AGENT_HOOK_ENDPOINT).toBeUndefined()
    expect(env.ORCA_AGENT_HOOK_ENV).toBe('development')
    expect(env.ORCA_AGENT_HOOK_PORT).toBe('1234')
    expect(env.ORCA_AGENT_HOOK_TOKEN).toBe('token')
  })

  it('preserves explicit development agent hook endpoint files', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const previousEndpoint = process.env.ORCA_AGENT_HOOK_ENDPOINT
    process.env.ORCA_AGENT_HOOK_ENDPOINT = '/tmp/stale-endpoint.env'

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        env: {
          ORCA_AGENT_HOOK_ENV: 'development',
          ORCA_AGENT_HOOK_PORT: '1234',
          ORCA_AGENT_HOOK_TOKEN: 'token',
          ORCA_AGENT_HOOK_VERSION: '1',
          ORCA_AGENT_HOOK_ENDPOINT: '/tmp/fresh-endpoint.env'
        }
      })
    } finally {
      if (previousEndpoint === undefined) {
        delete process.env.ORCA_AGENT_HOOK_ENDPOINT
      } else {
        process.env.ORCA_AGENT_HOOK_ENDPOINT = previousEndpoint
      }
    }

    const env = spawnMock.mock.calls.at(-1)?.[2].env
    expect(env.ORCA_AGENT_HOOK_ENDPOINT).toBe('/tmp/fresh-endpoint.env')
    expect(env.ORCA_AGENT_HOOK_ENV).toBe('development')
    expect(env.ORCA_AGENT_HOOK_PORT).toBe('1234')
    expect(env.ORCA_AGENT_HOOK_TOKEN).toBe('token')
  })

  it('forwards write calls', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    handle.write('ls\n')

    expect(proc.write).toHaveBeenCalledWith('ls\n')
  })

  it('forwards resize calls', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    handle.resize(120, 40)

    expect(proc.resize).toHaveBeenCalledWith(120, 40)
  })

  it('normalizes invalid initial spawn dimensions', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    createPtySubprocess({ sessionId: 'test', cols: 0, rows: -1 })

    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ cols: 80, rows: 24 })
    )
  })

  it('ignores transient zero-size resize calls', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    handle.resize(0, 0)
    handle.write('still alive\n')

    expect(proc.resize).not.toHaveBeenCalled()
    expect(proc.write).toHaveBeenCalledWith('still alive\n')
  })

  it('forwards kill calls', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    handle.kill()

    expect(proc.kill).toHaveBeenCalled()
  })

  it('forceKill sends SIGKILL to the child pid', () => {
    const proc = mockPtyProcess(77)
    spawnMock.mockReturnValue(proc)
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)

    const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    handle.forceKill()

    expect(killSpy).toHaveBeenCalledWith(77, 'SIGKILL')
    killSpy.mockRestore()
  })

  it('routes onData events', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    const data: string[] = []
    handle.onData((d) => data.push(d))

    proc._simulateData('hello')
    expect(data).toEqual(['hello'])
  })

  it('replays data emitted before the Session registers onData', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    proc._simulateData('early setup output\r\n')
    const data: string[] = []
    handle.onData((d) => data.push(d))

    expect(data).toEqual(['early setup output\r\n'])
  })

  it('routes onExit events', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    const codes: number[] = []
    handle.onExit((code) => codes.push(code))

    proc._simulateExit(42)
    expect(codes).toEqual([42])
  })

  it('replays pre-listener data before a pre-listener exit', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    proc._simulateData('last output\r\n')
    proc._simulateExit(7)
    const data: string[] = []
    const codes: number[] = []
    handle.onData((d) => data.push(d))
    handle.onExit((code) => codes.push(code))

    expect(data).toEqual(['last output\r\n'])
    expect(codes).toEqual([7])
  })

  it('preserves pre-listener data when onExit is registered before onData', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    proc._simulateData('last output\r\n')
    proc._simulateExit(7)
    const events: string[] = []
    handle.onExit((code) => events.push(`exit:${code}`))
    handle.onData((data) => events.push(`data:${data}`))

    expect(events).toEqual(['exit:7', 'data:last output\r\n'])
  })

  it('sends signal via process.kill', () => {
    const proc = mockPtyProcess(99)
    spawnMock.mockReturnValue(proc)

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    handle.signal('SIGINT')

    expect(killSpy).toHaveBeenCalledWith(99, 'SIGINT')
    killSpy.mockRestore()
  })

  it('uses SHELL env or defaults to /bin/zsh on non-Windows', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })

    const shellArg = spawnMock.mock.calls[0][0]
    expect(typeof shellArg).toBe('string')
    expect(shellArg.length).toBeGreaterThan(0)
  })

  it('passes custom env to spawned process', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    createPtySubprocess({
      sessionId: 'test',
      cols: 80,
      rows: 24,
      env: { MY_VAR: 'test-value' }
    })

    const lastCall = spawnMock.mock.calls.at(-1)!
    const spawnEnv = lastCall[2].env
    expect(spawnEnv.MY_VAR).toBe('test-value')
  })

  it('uses shell wrapper when attribution shims must survive shell startup', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        env: {
          SHELL: '/bin/zsh',
          ORCA_ATTRIBUTION_SHIM_DIR: '/tmp/orca-terminal-attribution/posix'
        }
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    const lastCall = spawnMock.mock.calls.at(-1)!
    expect(lastCall[1]).toEqual(['-l'])
    expect(lastCall[2].env.ZDOTDIR).toMatch(ZSH_SHELL_READY_DIR)
    expect(lastCall[2].env.ORCA_SHELL_READY_MARKER).toBe('0')
  })

  it('uses shell wrapper when OpenCode config must survive shell startup', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        env: {
          SHELL: '/bin/zsh',
          OPENCODE_CONFIG_DIR: '/tmp/orca-opencode-overlay',
          ORCA_OPENCODE_CONFIG_DIR: '/tmp/orca-opencode-overlay'
        }
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    const lastCall = spawnMock.mock.calls.at(-1)!
    expect(lastCall[1]).toEqual(['-l'])
    expect(lastCall[2].env.ZDOTDIR).toMatch(ZSH_SHELL_READY_DIR)
    expect(lastCall[2].env.ORCA_SHELL_READY_MARKER).toBe('0')
  })

  it('uses shell wrapper when typed OMP commands need the status extension', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        env: {
          SHELL: '/bin/zsh',
          ORCA_OMP_STATUS_EXTENSION: '/tmp/.omp/agent/extensions/orca-agent-status.ts'
        }
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    const lastCall = spawnMock.mock.calls.at(-1)!
    expect(lastCall[1]).toEqual(['-l'])
    expect(lastCall[2].env.ZDOTDIR).toMatch(ZSH_SHELL_READY_DIR)
    expect(lastCall[2].env.ORCA_SHELL_READY_MARKER).toBe('0')
  })

  it('uses shell wrapper when Codex home must survive shell startup', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        env: {
          SHELL: '/bin/zsh',
          CODEX_HOME: '/tmp/orca-codex-home',
          ORCA_CODEX_HOME: '/tmp/orca-codex-home'
        }
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    const lastCall = spawnMock.mock.calls.at(-1)!
    expect(lastCall[1]).toEqual(['-l'])
    expect(lastCall[2].env.ZDOTDIR).toMatch(ZSH_SHELL_READY_DIR)
    expect(lastCall[2].env.ORCA_SHELL_READY_MARKER).toBe('0')
  })

  it('uses shell wrapper when Agent Teams shim path must survive shell startup', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        env: {
          SHELL: '/bin/zsh',
          PATH: '/tmp/orca-agent-teams-bin:/usr/bin',
          ORCA_AGENT_TEAMS_TEAM_ID: 'team-test',
          ORCA_AGENT_TEAMS_SHIM_DIR: '/tmp/orca-agent-teams-bin'
        }
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    const lastCall = spawnMock.mock.calls.at(-1)!
    expect(lastCall[1]).toEqual(['-l'])
    expect(lastCall[2].env.ZDOTDIR).toMatch(ZSH_SHELL_READY_DIR)
    expect(lastCall[2].env.ORCA_SHELL_READY_MARKER).toBe('0')
  })

  it('keeps plain Codex startup commands on the no-marker wrapper', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        command: 'codex',
        env: { SHELL: '/bin/zsh' }
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    const lastCall = spawnMock.mock.calls.at(-1)!
    expect(lastCall[1]).toEqual(['-l'])
    expect(lastCall[2].env.ZDOTDIR).toMatch(ZSH_SHELL_READY_DIR)
    expect(lastCall[2].env.ORCA_SHELL_READY_MARKER).toBe('0')
  })

  it('uses shell-ready wrapper for delivery-hinted Codex startup commands', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        command: "codex 'linked issue context'",
        startupCommandDelivery: 'shell-ready',
        env: { SHELL: '/bin/zsh' }
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    const lastCall = spawnMock.mock.calls.at(-1)!
    expect(lastCall[1]).toEqual(['-l'])
    expect(lastCall[2].env.ZDOTDIR).toMatch(ZSH_SHELL_READY_DIR)
    expect(lastCall[2].env.ORCA_SHELL_READY_MARKER).toBe('1')
  })

  it('uses shell-ready wrapper for Codex native prefill flags', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        command: "codex --prefill 'linked issue context'",
        env: { SHELL: '/bin/zsh' }
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    const lastCall = spawnMock.mock.calls.at(-1)!
    expect(lastCall[1]).toEqual(['-l'])
    expect(lastCall[2].env.ZDOTDIR).toMatch(ZSH_SHELL_READY_DIR)
    expect(lastCall[2].env.ORCA_SHELL_READY_MARKER).toBe('1')
  })

  it('deletes requested env keys after merging daemon process env', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = '/host/codex-home'

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        env: { SHELL: '/bin/bash' },
        envToDelete: ['CODEX_HOME']
      })
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME
      } else {
        process.env.CODEX_HOME = previousCodexHome
      }
    }

    const lastCall = spawnMock.mock.calls.at(-1)!
    expect(lastCall[2].env.CODEX_HOME).toBeUndefined()
  })

  it('honors explicit terminal env overrides after deleting requested defaults', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    createPtySubprocess({
      sessionId: 'test',
      cols: 80,
      rows: 24,
      env: {
        SHELL: '/bin/bash',
        TERM: 'screen-256color',
        PATH: '/tmp/orca-agent-teams-bin:/usr/bin',
        ORCA_AGENT_TEAMS_TEAM_ID: 'team-test'
      },
      envToDelete: ['TERM_PROGRAM', 'ORCA_ATTRIBUTION_SHIM_DIR']
    })

    const lastCall = spawnMock.mock.calls.at(-1)!
    expect(lastCall[2].name).toBe('screen-256color')
    expect(lastCall[2].env.TERM).toBe('screen-256color')
    expect(lastCall[2].env.PATH.split(':')[0]).toBe('/tmp/orca-agent-teams-bin')
    expect(lastCall[2].env.TERM_PROGRAM).toBeUndefined()
    expect(lastCall[2].env.ORCA_ATTRIBUTION_SHIM_DIR).toBeUndefined()
  })

  it('combines HOMEDRIVE and HOMEPATH for Windows default cwd', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    const originalUserProfile = process.env.USERPROFILE
    const originalHomeDrive = process.env.HOMEDRIVE
    const originalHomePath = process.env.HOMEPATH

    Object.defineProperty(process, 'platform', { value: 'win32' })
    delete process.env.USERPROFILE
    process.env.HOMEDRIVE = 'D:'
    process.env.HOMEPATH = '\\Users\\orca'

    try {
      createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE
      } else {
        process.env.USERPROFILE = originalUserProfile
      }
      if (originalHomeDrive === undefined) {
        delete process.env.HOMEDRIVE
      } else {
        process.env.HOMEDRIVE = originalHomeDrive
      }
      if (originalHomePath === undefined) {
        delete process.env.HOMEPATH
      } else {
        process.env.HOMEPATH = originalHomePath
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ cwd: 'D:\\Users\\orca' })
    )
  })

  it('keeps powershell.exe when the inbox PowerShell implementation is selected on Windows', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })
    isPwshAvailableMock.mockReturnValue(true)

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        env: { COMSPEC: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
        terminalWindowsPowerShellImplementation: 'powershell.exe'
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      'powershell.exe',
      POWERSHELL_OSC133_COMMAND_ARGS,
      expect.any(Object)
    )
  })

  it('spawns pwsh.exe when PowerShell 7 is selected and available on Windows', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })
    isPwshAvailableMock.mockReturnValue(true)

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        env: { COMSPEC: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
        terminalWindowsPowerShellImplementation: 'pwsh.exe'
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      'pwsh.exe',
      POWERSHELL_OSC133_COMMAND_ARGS,
      expect.any(Object)
    )
  })

  it('falls back to powershell.exe when PowerShell 7 is selected but unavailable on Windows', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })
    isPwshAvailableMock.mockReturnValue(false)

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        env: { COMSPEC: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
        terminalWindowsPowerShellImplementation: 'pwsh.exe'
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      'powershell.exe',
      POWERSHELL_OSC133_COMMAND_ARGS,
      expect.any(Object)
    )
  })

  it('falls back to powershell.exe when shellOverride requests pwsh.exe but pwsh is unavailable on Windows', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })
    isPwshAvailableMock.mockReturnValue(false)

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        shellOverride: 'pwsh.exe',
        terminalWindowsPowerShellImplementation: 'pwsh.exe'
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      'powershell.exe',
      POWERSHELL_OSC133_COMMAND_ARGS,
      expect.any(Object)
    )
  })

  it('ignores the PowerShell implementation setting for cmd.exe on Windows', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })
    isPwshAvailableMock.mockReturnValue(true)

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        shellOverride: 'cmd.exe',
        terminalWindowsPowerShellImplementation: 'pwsh.exe'
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      'cmd.exe',
      ['/K', 'chcp 65001 > nul'],
      expect.any(Object)
    )
  })

  it('embeds short PowerShell startup commands in the Windows shell launch', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })

    let handle: ReturnType<typeof createPtySubprocess>
    try {
      handle = createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        shellOverride: 'powershell.exe',
        command: "& 'codex' '--no-alt-screen'"
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    const lastCall = spawnMock.mock.calls.at(-1)!
    const encoded = String(lastCall[1][3])
    const command = Buffer.from(encoded, 'base64').toString('utf16le')
    expect(command.trimEnd().endsWith("& 'codex' '--no-alt-screen'")).toBe(true)
    expect(handle!.startupCommandDeliveredInShellArgs).toBe(true)
  })

  it('keeps oversized Windows startup commands on PTY stdin delivery', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })

    let handle: ReturnType<typeof createPtySubprocess>
    try {
      handle = createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        shellOverride: 'cmd.exe',
        command: `codex ${'x'.repeat(7000)}`
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      'cmd.exe',
      ['/K', 'chcp 65001 > nul'],
      expect.any(Object)
    )
    expect(handle!.startupCommandDeliveredInShellArgs).toBeUndefined()
  })

  it('launches Git Bash with login args and CHERE_INVOKING on Windows', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd: 'C:\\Users\\jin\\repo',
        shellOverride: 'C:\\PortableGit\\bin\\bash.exe'
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      'C:\\PortableGit\\bin\\bash.exe',
      ['--login', '-i'],
      expect.objectContaining({
        cwd: 'C:\\Users\\jin\\repo',
        env: expect.objectContaining({ CHERE_INVOKING: '1' })
      })
    )
  })

  it('rejects a missing explicit native Windows cwd before node-pty spawn', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })

    try {
      expect(() =>
        createPtySubprocess({
          sessionId: 'test',
          cols: 80,
          rows: 24,
          cwd: 'C:\\definitely-missing-orca-cwd',
          shellOverride: 'powershell.exe'
        })
      ).toThrow(/Working directory "C:\\definitely-missing-orca-cwd" does not exist/)
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('normalizes MSYS drive cwd before spawning daemon PowerShell on Windows', () => {
    const proc = mockPtyProcess()
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    spawnMock.mockImplementation((_shell, _args, options) => {
      if (options.cwd === '/c/Users/alice/project') {
        throw new Error('Cannot create process, error code: 267')
      }
      return proc
    })

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd: '/c/Users/alice/project',
        shellOverride: 'powershell.exe'
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      'powershell.exe',
      POWERSHELL_OSC133_COMMAND_ARGS,
      expect.objectContaining({ cwd: 'C:\\Users\\alice\\project' })
    )
  })

  it('validates the requested Windows cwd before launching WSL on Windows', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })

    try {
      expect(() =>
        createPtySubprocess({
          sessionId: 'test',
          cols: 80,
          rows: 24,
          cwd: 'C:\\definitely-missing-orca-wsl-cwd',
          shellOverride: 'wsl.exe'
        })
      ).toThrow(/Working directory "C:\\definitely-missing-orca-wsl-cwd" does not exist/)
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('adds shell and cwd context when node-pty reports File not found on Windows', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    spawnMock.mockImplementation(() => {
      throw new Error('File not found: ')
    })

    try {
      expect(() =>
        createPtySubprocess({
          sessionId: 'test',
          cols: 80,
          rows: 24,
          shellOverride: 'not-a-real-shell.exe'
        })
      ).toThrow(
        /Daemon failed to spawn shell "not-a-real-shell\.exe" with cwd ".+": File not found:/
      )
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('falls back to /mnt/c before launching WSL when cwd is not a native Windows path', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    const cwd = mkdtempSync(join(tmpdir(), 'daemon-pty-wsl-cwd-test-'))

    Object.defineProperty(process, 'platform', { value: 'win32' })

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd,
        shellOverride: 'wsl.exe'
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
      rmSync(cwd, { recursive: true, force: true })
    }

    const normalizedCwd = cwd.replace(/\\/g, '/')
    const driveMatch = normalizedCwd.match(/^([A-Za-z]):\/?(.*)$/)
    const expectedLinuxCwd = driveMatch
      ? `/mnt/${driveMatch[1].toLowerCase()}${driveMatch[2] ? `/${driveMatch[2]}` : ''}`
      : '/mnt/c'

    expect(spawnMock).toHaveBeenCalledWith(
      'wsl.exe',
      ['--', 'sh', '-c', expect.stringContaining(`cd '${expectedLinuxCwd}'`)],
      expect.objectContaining({ cwd: expect.any(String) })
    )
  })

  it('uses the preferred WSL distro for daemon WSL terminals with Windows cwd', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    const cwd = mkdtempSync(join(tmpdir(), 'daemon-pty-wsl-distro-test-'))

    Object.defineProperty(process, 'platform', { value: 'win32' })

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd,
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: 'Debian'
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
      rmSync(cwd, { recursive: true, force: true })
    }

    const normalizedCwd = cwd.replace(/\\/g, '/')
    const driveMatch = normalizedCwd.match(/^([A-Za-z]):\/?(.*)$/)
    const expectedLinuxCwd = driveMatch
      ? `/mnt/${driveMatch[1].toLowerCase()}${driveMatch[2] ? `/${driveMatch[2]}` : ''}`
      : '/mnt/c'

    expect(spawnMock).toHaveBeenCalledWith(
      'wsl.exe',
      ['-d', 'Debian', '--', 'sh', '-c', expect.stringContaining(`cd '${expectedLinuxCwd}'`)],
      expect.objectContaining({ cwd: expect.any(String) })
    )
  })

  it('launches WSL for WSL worktree cwd even when a stale Windows shell override is present', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo',
        shellOverride: 'powershell.exe'
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      'wsl.exe',
      ['-d', 'Ubuntu', '--', 'sh', '-c', expect.stringContaining("cd '/home/jin/repo'")],
      expect.objectContaining({ cwd: expect.any(String) })
    )
  })

  it('does not pass a Windows Codex home into daemon WSL terminals', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo',
        env: { CODEX_HOME: 'C:\\Users\\jin\\.codex', ORCA_CODEX_HOME: 'C:\\Users\\jin\\.codex' }
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      'wsl.exe',
      ['-d', 'Ubuntu', '--', 'sh', '-c', expect.stringContaining("cd '/home/jin/repo'")],
      expect.objectContaining({
        env: expect.not.objectContaining({
          CODEX_HOME: expect.anything(),
          ORCA_CODEX_HOME: expect.anything()
        })
      })
    )
  })

  it('does not pass a WSL managed Codex home into daemon Windows terminals', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd: 'C:\\Users\\jin\\repo',
        env: {
          CODEX_HOME:
            '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home',
          ORCA_CODEX_HOME:
            '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home'
        }
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        env: expect.not.objectContaining({
          CODEX_HOME: expect.anything(),
          ORCA_CODEX_HOME: expect.anything()
        })
      })
    )
  })

  it('routes daemon default WSL terminals to the Codex home distro without losing cwd', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    const cwd = mkdtempSync(join(tmpdir(), 'daemon-pty-wsl-codex-home-cwd-'))

    Object.defineProperty(process, 'platform', { value: 'win32' })

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd,
        shellOverride: 'wsl.exe',
        env: {
          CODEX_HOME:
            '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home',
          ORCA_CODEX_HOME:
            '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home'
        }
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
      rmSync(cwd, { recursive: true, force: true })
    }

    const normalizedCwd = cwd.replace(/\\/g, '/')
    const driveMatch = normalizedCwd.match(/^([A-Za-z]):\/?(.*)$/)
    const expectedLinuxCwd = driveMatch
      ? `/mnt/${driveMatch[1].toLowerCase()}${driveMatch[2] ? `/${driveMatch[2]}` : ''}`
      : '/mnt/c'

    expect(spawnMock).toHaveBeenCalledWith(
      'wsl.exe',
      ['-d', 'Ubuntu', '--', 'sh', '-c', expect.stringContaining(`cd '${expectedLinuxCwd}'`)],
      expect.objectContaining({
        env: expect.objectContaining({
          CODEX_HOME: '/home/jin/.local/share/orca/codex-accounts/a/home',
          ORCA_CODEX_HOME: '/home/jin/.local/share/orca/codex-accounts/a/home',
          WSLENV: expect.stringContaining('CODEX_HOME')
        })
      })
    )
  })

  it('preserves an explicit Linux Codex home in daemon WSL terminals', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo',
        env: { CODEX_HOME: '/home/jin/.codex-alt' }
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      'wsl.exe',
      ['-d', 'Ubuntu', '--', 'sh', '-c', expect.stringContaining("cd '/home/jin/repo'")],
      expect.objectContaining({
        env: expect.objectContaining({ CODEX_HOME: '/home/jin/.codex-alt' })
      })
    )
  })

  it('marks Orca terminal handles for WSL env import in daemon WSL terminals', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    const savedCodexHome = process.env.CODEX_HOME
    const savedOrcaCodexHome = process.env.ORCA_CODEX_HOME

    Object.defineProperty(process, 'platform', { value: 'win32' })
    delete process.env.CODEX_HOME
    delete process.env.ORCA_CODEX_HOME

    try {
      createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo',
        env: {
          ORCA_TERMINAL_HANDLE: 'term_wsl',
          WSLENV: 'FOO/u'
        }
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
      if (savedCodexHome === undefined) {
        delete process.env.CODEX_HOME
      } else {
        process.env.CODEX_HOME = savedCodexHome
      }
      if (savedOrcaCodexHome === undefined) {
        delete process.env.ORCA_CODEX_HOME
      } else {
        process.env.ORCA_CODEX_HOME = savedOrcaCodexHome
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      'wsl.exe',
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          ORCA_TERMINAL_HANDLE: 'term_wsl',
          WSLENV: 'FOO/u:ORCA_TERMINAL_HANDLE/u'
        })
      })
    )
  })

  it('keeps daemon WSL split panes in their distro when cwd is already POSIX', () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })

    try {
      createPtySubprocess({
        sessionId: 'repo::\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo@@deadbeef',
        cols: 80,
        rows: 24,
        cwd: '/home/jin/repo/subdir',
        shellOverride: 'wsl.exe'
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(validateWorkingDirectoryMock).toHaveBeenCalledWith(
      '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo\\subdir'
    )
    expect(spawnMock).toHaveBeenCalledWith(
      'wsl.exe',
      ['-d', 'Ubuntu', '--', 'sh', '-c', expect.stringContaining("cd '/home/jin/repo/subdir'")],
      expect.objectContaining({ cwd: expect.any(String) })
    )
  })

  // Why: node-pty's UnixTerminal.destroy() registers _socket.once('close', () =>
  // this.kill('SIGHUP')), and the socket 'close' event can fire concurrently
  // with onExit. If kill is not neutralized by the time close fires, SIGHUP
  // targets a reaped pid that may have been recycled. These tests pin down the
  // neutralization contract on both onExit (natural-exit path) and dispose()
  // (forced-teardown path) for POSIX, and verify Windows is exempt.
  describe('proc.kill neutralization for SIGHUP-to-recycled-pid hazard', () => {
    const restorePlatform = (desc?: PropertyDescriptor) => {
      if (desc) {
        Object.defineProperty(process, 'platform', desc)
      }
    }

    it('neutralizes proc.kill on POSIX inside proc.onExit synchronously', () => {
      const proc = mockPtyProcess()
      spawnMock.mockReturnValue(proc)
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'linux' })
      const originalKill = proc.kill
      try {
        createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
        expect(proc.kill).toBe(originalKill)
        proc._simulateExit(0)
        expect(proc.kill).not.toBe(originalKill)
        // Calling the neutralized kill is a safe no-op.
        expect(() => (proc.kill as () => void)()).not.toThrow()
      } finally {
        restorePlatform(origPlatform)
      }
    })

    it('DOES NOT neutralize proc.kill on Windows (WindowsTerminal.destroy needs kill)', () => {
      const proc = mockPtyProcess()
      spawnMock.mockReturnValue(proc)
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const originalKill = proc.kill
      try {
        createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
        proc._simulateExit(0)
        expect(proc.kill).toBe(originalKill)
      } finally {
        restorePlatform(origPlatform)
      }
    })

    it('dispose() neutralizes proc.kill on POSIX before calling destroy()', () => {
      const proc = mockPtyProcess() as ReturnType<typeof mockPtyProcess> & {
        destroy: ReturnType<typeof vi.fn>
      }
      proc.destroy = vi.fn()
      spawnMock.mockReturnValue(proc)
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      const originalKill = proc.kill
      try {
        const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
        handle.dispose()
        expect(proc.kill).not.toBe(originalKill)
        expect(proc.destroy).toHaveBeenCalledOnce()
      } finally {
        restorePlatform(origPlatform)
      }
    })

    it('dispose() on Windows calls destroy() without neutralizing kill', () => {
      const proc = mockPtyProcess() as ReturnType<typeof mockPtyProcess> & {
        destroy: ReturnType<typeof vi.fn>
      }
      proc.destroy = vi.fn()
      spawnMock.mockReturnValue(proc)
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const originalKill = proc.kill
      try {
        const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
        handle.dispose()
        expect(proc.kill).toBe(originalKill)
        expect(proc.destroy).toHaveBeenCalledOnce()
      } finally {
        restorePlatform(origPlatform)
      }
    })

    it('dispose() on Windows skips destroy after node-pty kill()', () => {
      const proc = mockPtyProcess() as ReturnType<typeof mockPtyProcess> & {
        destroy: ReturnType<typeof vi.fn>
      }
      proc.destroy = vi.fn(() => proc.kill())
      spawnMock.mockReturnValue(proc)
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32' })
      try {
        const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
        handle.kill()
        handle.dispose()
        expect(proc.kill).toHaveBeenCalledOnce()
        expect(proc.destroy).not.toHaveBeenCalled()
      } finally {
        restorePlatform(origPlatform)
      }
    })

    it('dispose() on Windows skips destroy after forceKill falls back to node-pty kill()', () => {
      const proc = mockPtyProcess(123456) as ReturnType<typeof mockPtyProcess> & {
        destroy: ReturnType<typeof vi.fn>
      }
      proc.destroy = vi.fn(() => proc.kill())
      spawnMock.mockReturnValue(proc)
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('already gone')
      })
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32' })
      try {
        const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
        handle.forceKill()
        handle.dispose()
        expect(killSpy).toHaveBeenCalledWith(123456, 'SIGKILL')
        expect(proc.kill).toHaveBeenCalledOnce()
        expect(proc.destroy).not.toHaveBeenCalled()
      } finally {
        killSpy.mockRestore()
        restorePlatform(origPlatform)
      }
    })

    it('dispose() is idempotent — second call does not re-invoke destroy', () => {
      const proc = mockPtyProcess() as ReturnType<typeof mockPtyProcess> & {
        destroy: ReturnType<typeof vi.fn>
      }
      proc.destroy = vi.fn()
      spawnMock.mockReturnValue(proc)
      const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
      handle.dispose()
      handle.dispose()
      expect(proc.destroy).toHaveBeenCalledOnce()
    })
  })

  // Why: after proc.onExit fires (dead=true), proc.pid refers to a reaped child
  // whose pid may have been recycled to an unrelated process. forceKill and
  // signal call process.kill(proc.pid, ...) directly, bypassing the
  // proc.kill-neutralization applied to the node-pty instance. Without an
  // internal dead-guard, they can deliver SIGKILL/SIGINT/etc to a stranger.
  describe('forceKill/signal guard against recycled pid after exit', () => {
    it('forceKill is a no-op once proc.onExit has fired', () => {
      const proc = mockPtyProcess(55)
      spawnMock.mockReturnValue(proc)
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
      const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
      proc._simulateExit(0)
      handle.forceKill()
      expect(killSpy).not.toHaveBeenCalled()
      killSpy.mockRestore()
    })

    it('signal is a no-op once proc.onExit has fired', () => {
      const proc = mockPtyProcess(55)
      spawnMock.mockReturnValue(proc)
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
      const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
      proc._simulateExit(0)
      handle.signal('SIGINT')
      expect(killSpy).not.toHaveBeenCalled()
      killSpy.mockRestore()
    })

    it('forceKill before exit still fires SIGKILL (live child)', () => {
      const proc = mockPtyProcess(77)
      spawnMock.mockReturnValue(proc)
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
      const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
      handle.forceKill()
      expect(killSpy).toHaveBeenCalledWith(77, 'SIGKILL')
      killSpy.mockRestore()
    })
  })
})
