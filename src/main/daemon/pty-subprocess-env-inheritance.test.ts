// Which daemon process env reaches the spawned shell, and how PATH is composed.
import { describe, expect, it, vi } from 'vitest'
import { delimiter } from 'node:path'
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
vi.mock('../providers/windows-conpty-process-membership', () => ({
  readWindowsConptyProcessIds: () => Promise.resolve(new Set([12345]))
}))

import { createPtySubprocess } from './pty-subprocess'
import {
  LEGACY_TERMINAL_SHIM_ENV_KEYS,
  stripLegacyTerminalShimEnv
} from '../pty/legacy-terminal-shim-dir'
import { mockPtyProcess, useDaemonPtySubprocessEnv } from './pty-subprocess-test-harness'

describe('createPtySubprocess', () => {
  useDaemonPtySubprocessEnv({
    spawnMock,
    isPwshAvailableMock,
    resolveUnixShellPathMock,
    resolveAgentForegroundProcessMock,
    validateWorkingDirectoryMock
  })

  it('expands variables in PATH before spawning a Windows shell', async () => {
    spawnMock.mockReturnValue(mockPtyProcess())
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd: 'C:\\repo',
        env: {
          ORCA_AGENT_TEAMS_TEAM_ID: 'team-test',
          ORCA_PATH_ROOT: 'C:\\Users\\orca\\AppData\\Local',
          PATH: '%orca_path_root%\\agy\\bin;C:\\Windows'
        }
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock.mock.calls.at(-1)?.[2].env.PATH).toBe(
      'C:\\Users\\orca\\AppData\\Local\\agy\\bin;C:\\Windows'
    )
  })

  it('does not inherit parent Orca pane identity when caller omits pane env', async () => {
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
      await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
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

  it('preserves explicit child Orca pane identity over parent env', async () => {
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
      await createPtySubprocess({
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

  it.each([
    // fish EXPORTS fish_history, so a daemon started from a fish pane would hand
    // every session the launching worktree's history file (STA-4682). Only the
    // name this spawn asked for — the isolated one, or the user's — may stand.
    ['drops an inherited Orca fish_history', undefined, undefined],
    ['keeps the session this spawn injected', 'orca_c0ffee', 'orca_c0ffee'],
    ['keeps a caller-supplied value', 'mine', 'mine']
  ])('%s', async (_name, requested, expected) => {
    spawnMock.mockReturnValue(mockPtyProcess())
    const saved = process.env.fish_history
    process.env.fish_history = 'orca_abc123'

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        ...(requested === undefined ? {} : { env: { fish_history: requested } })
      })
    } finally {
      if (saved === undefined) {
        delete process.env.fish_history
      } else {
        process.env.fish_history = saved
      }
    }

    expect(spawnMock.mock.calls.at(-1)?.[2].env.fish_history).toBe(expected)
  })

  it.each([
    // HISTFILE is exported too, so a daemon started from an Orca pane would hand
    // every session the launching worktree's history file.
    ['drops an inherited Orca HISTFILE', undefined, undefined],
    [
      'keeps the path this spawn injected',
      '/fake/userData/terminal-history/00112233445566aa/zsh_history',
      '/fake/userData/terminal-history/00112233445566aa/zsh_history'
    ],
    ['keeps a caller-supplied value', '/home/me/.zsh_history', '/home/me/.zsh_history']
  ])('%s', async (_name, requested, expected) => {
    spawnMock.mockReturnValue(mockPtyProcess())
    const saved = process.env.HISTFILE
    process.env.HISTFILE = '/fake/userData/terminal-history/aabbccddeeff0011/zsh_history'

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        ...(requested === undefined ? {} : { env: { HISTFILE: requested } })
      })
    } finally {
      if (saved === undefined) {
        delete process.env.HISTFILE
      } else {
        process.env.HISTFILE = saved
      }
    }

    expect(spawnMock.mock.calls.at(-1)?.[2].env.HISTFILE).toBe(expected)
  })

  it.each([
    // ORCA_HISTFILE is exported into every pane, so a daemon started from an
    // Orca pane inherits one. Left in place it BOTH re-scopes the pane to
    // another worktree's history file (#11146) and wraps a zsh pane nothing
    // asked to wrap, since `history` is selected on its presence.
    ['drops an inherited Orca ORCA_HISTFILE', undefined, undefined],
    [
      'keeps the path this spawn injected',
      '/fake/userData/terminal-history/00112233445566aa/zsh_history',
      '/fake/userData/terminal-history/00112233445566aa/zsh_history'
    ],
    ['keeps a caller-supplied value', '/home/me/.zsh_history', '/home/me/.zsh_history']
  ])('%s', async (_name, requested, expected) => {
    spawnMock.mockReturnValue(mockPtyProcess())
    const saved = process.env.ORCA_HISTFILE
    process.env.ORCA_HISTFILE = '/fake/userData/terminal-history/aabbccddeeff0011/zsh_history'

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        shellOverride: '/bin/zsh',
        ...(requested === undefined ? {} : { env: { ORCA_HISTFILE: requested } })
      })
    } finally {
      if (saved === undefined) {
        delete process.env.ORCA_HISTFILE
      } else {
        process.env.ORCA_HISTFILE = saved
      }
    }

    const env = spawnMock.mock.calls.at(-1)?.[2].env
    expect(env.ORCA_HISTFILE).toBe(expected)
    // The wrapping consequence: no inherited value may point a pane at Orca's
    // ZDOTDIR that the client scoped no history for.
    expect(env.ORCA_SHELL_FEATURES).toBe(expected === undefined ? undefined : 'history')
  })

  it('does not inherit ELECTRON_RUN_AS_NODE from the daemon process env', async () => {
    // Why: the daemon is forked with ELECTRON_RUN_AS_NODE=1. If that flag
    // reaches user shells, nested Electron commands run as plain Node.
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const previous = process.env.ELECTRON_RUN_AS_NODE
    process.env.ELECTRON_RUN_AS_NODE = '1'

    try {
      await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
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

  it('does not forward a half-activated conda env from the daemon process env', async () => {
    // Why here as well as the main process: the daemon fork composes its own
    // inherited env, which main never sees, so it is the default terminal's
    // only chance to drop a CONDA_SHLVL sentinel left without a prefix (#14195).
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const saved = {
      CONDA_SHLVL: process.env.CONDA_SHLVL,
      CONDA_PREFIX: process.env.CONDA_PREFIX,
      CONDA_DEFAULT_ENV: process.env.CONDA_DEFAULT_ENV,
      CONDA_EXE: process.env.CONDA_EXE
    }
    delete process.env.CONDA_PREFIX
    process.env.CONDA_SHLVL = '1'
    process.env.CONDA_DEFAULT_ENV = 'base'
    process.env.CONDA_EXE = '/opt/miniconda3/bin/conda'

    try {
      await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
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
    expect(env.CONDA_SHLVL).toBeUndefined()
    expect(env.CONDA_DEFAULT_ENV).toBeUndefined()
    expect(env.CONDA_EXE).toBe('/opt/miniconda3/bin/conda')
  })

  it('does not inherit legacy attribution state from a pre-upgrade daemon', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const saved = Object.fromEntries(
      [...LEGACY_TERMINAL_SHIM_ENV_KEYS, 'PATH'].map((key) => [key, process.env[key]])
    )
    process.env.ORCA_ENABLE_GIT_ATTRIBUTION = '1'
    process.env.ORCA_ATTRIBUTION_SHIM_DIR = '/tmp/orca-terminal-attribution/posix'
    process.env.PATH = `/tmp/orca-terminal-attribution/posix${delimiter}/usr/bin`

    try {
      await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
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
    expect(env.PATH).toBe('/usr/bin')
    for (const key of LEGACY_TERMINAL_SHIM_ENV_KEYS) {
      expect(env[key]).toBeUndefined()
    }
  })

  it('does not inherit NODE_ENV from the daemon process env', async () => {
    // Why: a dev-mode Orca forks the daemon with NODE_ENV=development; leaking
    // Orca's build mode into user shells breaks `next build` and Vitest.
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'

    try {
      await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    } finally {
      if (previous === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previous
      }
    }

    const env = spawnMock.mock.calls.at(-1)?.[2].env
    expect(env.NODE_ENV).toBeUndefined()
    const expectedEnv = { PATH: process.env.PATH ?? '' }
    stripLegacyTerminalShimEnv(expectedEnv, process.platform)
    expect(env.PATH).toBe(expectedEnv.PATH)
  })

  it('keeps an explicitly requested NODE_ENV for daemon PTY shells', async () => {
    // Why: only the ambient value is stripped; a caller-supplied NODE_ENV still wins.
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        env: { NODE_ENV: 'production' }
      })
    } finally {
      if (previous === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previous
      }
    }

    const env = spawnMock.mock.calls.at(-1)?.[2].env
    expect(env.NODE_ENV).toBe('production')
  })

  it('does not inherit AppImage runtime env into daemon PTY shells', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    const saved = {
      APPIMAGE: process.env.APPIMAGE,
      APPDIR: process.env.APPDIR,
      ARGV0: process.env.ARGV0,
      OWD: process.env.OWD,
      APPIMAGE_LIBRARY_PATH: process.env.APPIMAGE_LIBRARY_PATH,
      PATH: process.env.PATH,
      LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH
    }
    Object.defineProperty(process, 'platform', { value: 'linux' })
    process.env.APPIMAGE = '/data/apps/orca.appimage'
    process.env.APPDIR = '/tmp/.mount_orca123'
    process.env.ARGV0 = '/data/apps/orca.appimage'
    process.env.OWD = '/home/user/project'
    process.env.APPIMAGE_LIBRARY_PATH = '/tmp/.mount_orca123/usr/lib'
    process.env.PATH = ['/tmp/.mount_orca123', '/tmp/.mount_orca123/usr/sbin', '/usr/bin'].join(
      delimiter
    )
    process.env.LD_LIBRARY_PATH = ['/tmp/.mount_orca123/usr/lib', '/opt/audio/lib'].join(delimiter)

    try {
      await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }

    const env = spawnMock.mock.calls.at(-1)?.[2].env
    expect(env.APPIMAGE).toBeUndefined()
    expect(env.APPDIR).toBeUndefined()
    expect(env.ARGV0).toBeUndefined()
    expect(env.OWD).toBeUndefined()
    expect(env.APPIMAGE_LIBRARY_PATH).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
    expect(env.LD_LIBRARY_PATH).toBe('/opt/audio/lib')
  })

  it('does not inherit parent agent hook endpoint for development hook env', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const previousEndpoint = process.env.ORCA_AGENT_HOOK_ENDPOINT
    process.env.ORCA_AGENT_HOOK_ENDPOINT = '/tmp/stale-endpoint.env'

    try {
      await createPtySubprocess({
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

  it('preserves explicit development agent hook endpoint files', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const previousEndpoint = process.env.ORCA_AGENT_HOOK_ENDPOINT
    process.env.ORCA_AGENT_HOOK_ENDPOINT = '/tmp/stale-endpoint.env'

    try {
      await createPtySubprocess({
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

  it('passes custom env to spawned process', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    await createPtySubprocess({
      sessionId: 'test',
      cols: 80,
      rows: 24,
      env: { MY_VAR: 'test-value' }
    })

    const lastCall = spawnMock.mock.calls.at(-1)!
    const spawnEnv = lastCall[2].env
    expect(spawnEnv.MY_VAR).toBe('test-value')
  })

  it('honors explicit terminal env overrides after deleting requested defaults', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    await createPtySubprocess({
      sessionId: 'test',
      cols: 80,
      rows: 24,
      env: {
        SHELL: '/bin/bash',
        TERM: 'screen-256color',
        PATH: '/tmp/orca-agent-teams-bin:/usr/bin',
        ORCA_AGENT_TEAMS_TEAM_ID: 'team-test'
      },
      envToDelete: ['TERM_PROGRAM']
    })

    const lastCall = spawnMock.mock.calls.at(-1)!
    expect(lastCall[2].name).toBe('screen-256color')
    expect(lastCall[2].env.TERM).toBe('screen-256color')
    expect(lastCall[2].env.PATH.split(':')[0]).toBe('/tmp/orca-agent-teams-bin')
    expect(lastCall[2].env.TERM_PROGRAM).toBeUndefined()
  })

  it('collapses its own env merge onto the requested Windows `Path` spelling', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        // Why: buildPtyHostEnv collapses Windows PATH onto one spelling before the daemon wire;
        // the daemon then spreads its own block underneath and can re-mint the other one.
        env: {
          Path: '/tmp/orca-agent-teams-bin:/usr/bin',
          ORCA_AGENT_TEAMS_TEAM_ID: 'team-test'
        }
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    const env = spawnMock.mock.calls.at(-1)![2].env
    expect(Object.keys(env).filter((key) => /^path$/i.test(key))).toEqual(['Path'])
    expect(env.Path.split(':')[0]).toBe('/tmp/orca-agent-teams-bin')
  })

  it('keeps the daemon `PATH` block when the requested env has no path key', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    const expectedEnv = { PATH: process.env.PATH ?? '' }
    stripLegacyTerminalShimEnv(expectedEnv, 'win32')

    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24, env: { FOO: 'bar' } })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    const env = spawnMock.mock.calls.at(-1)![2].env
    expect(env.PATH).toBe(expectedEnv.PATH)
  })

  it('preserves a duplicated path block supplied by main', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        env: { PATH: 'C:\\Live', Path: 'C:\\Shadowed' }
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    const env = spawnMock.mock.calls.at(-1)![2].env
    expect(env.PATH).toBe('C:\\Live')
    expect(env.Path).toBe('C:\\Shadowed')
  })
})
