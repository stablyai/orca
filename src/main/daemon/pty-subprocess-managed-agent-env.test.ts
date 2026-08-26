// Daemon-managed agent env: shell wrapper survival and overlay deletion.
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

const ZSH_SHELL_READY_DIR = /shell-ready[\\/]zsh/

describe('createPtySubprocess', () => {
  useDaemonPtySubprocessEnv({
    spawnMock,
    isPwshAvailableMock,
    resolveUnixShellPathMock,
    resolveAgentForegroundProcessMock,
    validateWorkingDirectoryMock
  })

  it('uses shell wrapper when managed env must survive shell startup', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        env: {
          SHELL: '/bin/zsh',
          ORCA_OPENCODE_CONFIG_DIR: '/tmp/orca-opencode-config'
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
    expect(lastCall[2].env.ORCA_SHELL_FEATURES).not.toContain('ready')
  })

  it('uses shell wrapper when OpenCode config must survive shell startup', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })

    try {
      await createPtySubprocess({
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
    expect(lastCall[2].env.ORCA_SHELL_FEATURES).not.toContain('ready')
  })

  it('uses shell wrapper when MiMo home must survive shell startup', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        env: {
          SHELL: '/bin/zsh',
          MIMOCODE_HOME: '/tmp/orca-mimocode-overlay',
          ORCA_MIMOCODE_HOME: '/tmp/orca-mimocode-overlay'
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
    expect(lastCall[2].env.ORCA_SHELL_FEATURES).not.toContain('ready')
  })

  it('uses shell wrapper when typed OMP commands need the status extension', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })

    try {
      await createPtySubprocess({
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
    expect(lastCall[2].env.ORCA_SHELL_FEATURES).not.toContain('ready')
  })

  it('uses shell wrapper when Codex home must survive shell startup', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })

    try {
      await createPtySubprocess({
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
    expect(lastCall[2].env.ORCA_SHELL_FEATURES).not.toContain('ready')
  })

  it('uses shell wrapper when Agent Teams shim path must survive shell startup', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })

    try {
      await createPtySubprocess({
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
    expect(lastCall[2].env.ORCA_SHELL_FEATURES).not.toContain('ready')
  })

  it('keeps plain Codex startup commands on the no-marker wrapper', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd: '/repo',
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
    expect(lastCall[2].env.ORCA_SHELL_FEATURES).not.toContain('ready')
  })

  it('uses shell-ready wrapper for delivery-hinted Codex startup commands', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd: '/repo',
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
    expect(lastCall[2].env.ORCA_SHELL_FEATURES).toContain('ready')
  })

  it('uses shell-ready wrapper for Codex native prefill flags', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd: '/repo',
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
    expect(lastCall[2].env.ORCA_SHELL_FEATURES).toContain('ready')
  })

  it('deletes requested env keys after merging daemon process env', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = '/host/codex-home'

    try {
      await createPtySubprocess({
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

  it('deletes daemon-owned Codex overlay pairs when the private marker is requested', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const previousCodexHome = process.env.CODEX_HOME
    const previousOrcaCodexHome = process.env.ORCA_CODEX_HOME
    process.env.CODEX_HOME = '/daemon/managed/codex-home'
    process.env.ORCA_CODEX_HOME = '/daemon/managed/codex-home'

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        env: { SHELL: '/bin/bash' },
        envToDelete: ['ORCA_CODEX_HOME']
      })
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME
      } else {
        process.env.CODEX_HOME = previousCodexHome
      }
      if (previousOrcaCodexHome === undefined) {
        delete process.env.ORCA_CODEX_HOME
      } else {
        process.env.ORCA_CODEX_HOME = previousOrcaCodexHome
      }
    }

    const env = spawnMock.mock.calls.at(-1)![2].env
    expect(env.CODEX_HOME).toBeUndefined()
    expect(env.ORCA_CODEX_HOME).toBeUndefined()
  })

  it('strips an inherited per-account self-contained CODEX_HOME overlay in a nested Orca (#5370)', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const previousCodexHome = process.env.CODEX_HOME
    const previousOrcaCodexHome = process.env.ORCA_CODEX_HOME
    // A per-account home is injected as CODEX_HOME === ORCA_CODEX_HOME, so the
    // nested-Orca strip must clear it exactly as it does the shared mirror.
    const perAccountHome = '/daemon/managed/codex-accounts/019f0000-aaaa/home'
    process.env.CODEX_HOME = perAccountHome
    process.env.ORCA_CODEX_HOME = perAccountHome

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        env: { SHELL: '/bin/bash' },
        envToDelete: ['ORCA_CODEX_HOME']
      })
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME
      } else {
        process.env.CODEX_HOME = previousCodexHome
      }
      if (previousOrcaCodexHome === undefined) {
        delete process.env.ORCA_CODEX_HOME
      } else {
        process.env.ORCA_CODEX_HOME = previousOrcaCodexHome
      }
    }

    const env = spawnMock.mock.calls.at(-1)![2].env
    expect(env.CODEX_HOME).toBeUndefined()
    expect(env.ORCA_CODEX_HOME).toBeUndefined()
  })

  it('preserves a daemon-owned custom Codex home while deleting a stale private marker', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    const previousCodexHome = process.env.CODEX_HOME
    const previousOrcaCodexHome = process.env.ORCA_CODEX_HOME
    Object.defineProperty(process, 'platform', { value: 'linux' })
    process.env.CODEX_HOME = '/daemon/user/codex-home'
    process.env.ORCA_CODEX_HOME = '/daemon/stale/managed-home'

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        env: { SHELL: '/bin/bash' },
        envToDelete: ['ORCA_CODEX_HOME']
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME
      } else {
        process.env.CODEX_HOME = previousCodexHome
      }
      if (previousOrcaCodexHome === undefined) {
        delete process.env.ORCA_CODEX_HOME
      } else {
        process.env.ORCA_CODEX_HOME = previousOrcaCodexHome
      }
    }

    const env = spawnMock.mock.calls.at(-1)![2].env
    expect(env.CODEX_HOME).toBe('/daemon/user/codex-home')
    expect(env.ORCA_CODEX_HOME).toBeUndefined()
  })
})
