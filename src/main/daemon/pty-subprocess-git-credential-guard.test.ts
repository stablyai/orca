// Git prompt/credential guard env layered onto the inherited daemon Git config.
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
import {
  restoreGitCredentialGuardEnv,
  takeGitCredentialGuardEnv
} from '../../shared/git-credential-guard-env-test-harness'
import {
  applyTerminalGitCredentialPromptGuard,
  TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV
} from '../../shared/terminal-git-credential-guard'
import { mockPtyProcess, useDaemonPtySubprocessEnv } from './pty-subprocess-test-harness'

describe('createPtySubprocess', () => {
  useDaemonPtySubprocessEnv({
    spawnMock,
    isPwshAvailableMock,
    resolveUnixShellPathMock,
    resolveAgentForegroundProcessMock,
    validateWorkingDirectoryMock
  })

  it('appends Git prompt guards after the detached daemon inherited config', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    const previousWslEnv = process.env.WSLENV
    const savedGitConfigEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)
      )
    )
    for (const key of Object.keys(process.env)) {
      if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) {
        delete process.env[key]
      }
    }
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = 'core.quotePath'
    process.env.GIT_CONFIG_VALUE_0 = 'false'
    process.env.WSLENV = 'DAEMON_ONLY/p'
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    try {
      await createPtySubprocess({
        sessionId: 'guarded-git-config',
        cols: 80,
        rows: 24,
        env: {
          COMSPEC: CMD_ABS,
          [TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV]: 'guard'
        }
      })

      const spawnEnv = spawnMock.mock.calls.at(-1)?.[2]?.env as Record<string, string>
      expect(spawnEnv.GIT_TERMINAL_PROMPT).toBe('0')
      expect(spawnEnv.GCM_INTERACTIVE).toBe('never')
      expect(spawnEnv.GIT_CONFIG_COUNT).toBe('3')
      expect(spawnEnv.GIT_CONFIG_KEY_0).toBe('core.quotePath')
      expect(spawnEnv.GIT_CONFIG_VALUE_0).toBe('false')
      expect(spawnEnv.GIT_CONFIG_KEY_1).toBe('credential.interactive')
      expect(spawnEnv.GIT_CONFIG_KEY_2).toBe('credential.guiPrompt')
      expect((spawnEnv.WSLENV ?? '').split(':')).toContain('DAEMON_ONLY/p')
      expect((spawnEnv.WSLENV ?? '').split(':')).toContain('GIT_CONFIG_KEY_2')
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
      for (const key of Object.keys(process.env)) {
        if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) {
          delete process.env[key]
        }
      }
      Object.assign(process.env, savedGitConfigEnv)
      if (previousWslEnv === undefined) {
        delete process.env.WSLENV
      } else {
        process.env.WSLENV = previousWslEnv
      }
    }
  })

  it('does not infer a guard from caller-set prompt scalars', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const savedGitConfigEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)
      )
    )
    for (const key of Object.keys(process.env)) {
      if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) {
        delete process.env[key]
      }
    }
    process.env.GIT_CONFIG_COUNT = '3'
    process.env.GIT_CONFIG_KEY_0 = 'core.quotePath'
    process.env.GIT_CONFIG_VALUE_0 = 'false'
    process.env.GIT_CONFIG_KEY_1 = 'base.one'
    process.env.GIT_CONFIG_VALUE_1 = 'one'
    process.env.GIT_CONFIG_KEY_2 = 'base.two'
    process.env.GIT_CONFIG_VALUE_2 = 'two'

    try {
      await createPtySubprocess({
        sessionId: 'explicit-guarded-git-config',
        cols: 80,
        rows: 24,
        env: {
          SHELL: '/bin/bash',
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.proxy',
          GIT_CONFIG_VALUE_0: 'http://proxy.invalid'
        }
      })

      const spawnEnv = spawnMock.mock.calls.at(-1)?.[2]?.env as Record<string, string>
      expect(spawnEnv.GIT_TERMINAL_PROMPT).toBe('0')
      expect(spawnEnv.GCM_INTERACTIVE).toBe('never')
      expect(spawnEnv.GIT_CONFIG_COUNT).toBe('1')
      expect(spawnEnv.GIT_CONFIG_KEY_0).toBe('http.proxy')
      expect(spawnEnv.GIT_CONFIG_VALUE_0).toBe('http://proxy.invalid')
      expect(Object.values(spawnEnv)).not.toContain('core.quotePath')
      expect(Object.values(spawnEnv)).not.toContain('base.one')
      expect(Object.values(spawnEnv)).not.toContain('base.two')
      expect(spawnEnv.GIT_CONFIG_KEY_1).toBeUndefined()
    } finally {
      for (const key of Object.keys(process.env)) {
        if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) {
          delete process.env[key]
        }
      }
      Object.assign(process.env, savedGitConfigEnv)
    }
  })

  it('guards a trusted daemon agent whose launch command is wrapped', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    await createPtySubprocess({
      sessionId: 'trusted-wrapped-agent',
      cols: 80,
      rows: 24,
      command: 'cd /repo && custom-agent-wrapper',
      launchAgent: 'claude',
      env: { SHELL: '/bin/bash' }
    })

    const spawnEnv = spawnMock.mock.calls.at(-1)?.[2]?.env as Record<string, string>
    expect(spawnEnv.GIT_TERMINAL_PROMPT).toBe('0')
    expect(spawnEnv.GCM_INTERACTIVE).toBe('never')
    expect(Object.values(spawnEnv)).toContain('credential.interactive')
    expect(Object.values(spawnEnv)).toContain('credential.guiPrompt')
  })
  it('strips a guard the daemon inherited when the pane must not be guarded', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    // A daemon forked from a guarded agent pane: build its inherited env with the
    // real guard so the double carries every variable the guard actually sets.
    const inherited: Record<string, string> = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.quotePath',
      GIT_CONFIG_VALUE_0: 'false'
    }
    applyTerminalGitCredentialPromptGuard(inherited, {
      launchCommand: 'claude',
      platform: process.platform
    })
    const saved = takeGitCredentialGuardEnv(inherited)

    try {
      await createPtySubprocess({
        sessionId: 'inherited-guard-unguarded-pane',
        cols: 80,
        rows: 24,
        env: { SHELL: '/bin/bash' }
      })

      const spawnEnv = spawnMock.mock.calls.at(-1)?.[2]?.env as Record<string, string>
      expect(spawnEnv.GIT_TERMINAL_PROMPT).toBeUndefined()
      expect(spawnEnv.GCM_INTERACTIVE).toBeUndefined()
      expect(spawnEnv.GIT_ASKPASS).toBeUndefined()
      expect(spawnEnv.SSH_ASKPASS).toBeUndefined()
      // The caller's own entry survives; only Orca's appended pair is removed.
      expect(spawnEnv.GIT_CONFIG_COUNT).toBe('1')
      expect(spawnEnv.GIT_CONFIG_KEY_0).toBe('core.quotePath')
      expect(spawnEnv.GIT_CONFIG_VALUE_0).toBe('false')
      expect(spawnEnv.GIT_CONFIG_KEY_1).toBeUndefined()
      expect(Object.values(spawnEnv)).not.toContain('credential.interactive')
      expect(Object.values(spawnEnv)).not.toContain('credential.guiPrompt')
    } finally {
      restoreGitCredentialGuardEnv(saved)
    }
  })

  it('gives a guarded daemon pane what its children need to undo the guard', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const saved = takeGitCredentialGuardEnv({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.quotePath',
      GIT_CONFIG_VALUE_0: 'false'
    })

    try {
      await createPtySubprocess({
        sessionId: 'guarded-daemon-pane-provenance',
        cols: 80,
        rows: 24,
        env: { SHELL: '/bin/bash', [TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV]: 'guard' }
      })

      const paneEnv = spawnMock.mock.calls.at(-1)?.[2]?.env as Record<string, string>
      expect(paneEnv.GIT_TERMINAL_PROMPT).toBe('0')
      expect(paneEnv.GIT_CONFIG_COUNT).toBe('3')

      // A plain shell launched from inside that guarded pane.
      const child = { ...paneEnv }
      expect(
        applyTerminalGitCredentialPromptGuard(child, {
          launchCommand: '/bin/zsh',
          platform: process.platform
        })
      ).toBe(false)
      expect(child.GIT_TERMINAL_PROMPT).toBeUndefined()
      expect(child.GCM_INTERACTIVE).toBeUndefined()
      expect(child.GIT_CONFIG_COUNT).toBe('1')
      expect(child.GIT_CONFIG_KEY_0).toBe('core.quotePath')
      expect(child.GIT_CONFIG_KEY_1).toBeUndefined()
    } finally {
      restoreGitCredentialGuardEnv(saved)
    }
  })
  it('does not double the guard when the daemon inherited one and the request carries its own', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    // Orca was launched from a guarded agent pane, so the daemon it forked
    // inherits that pane's guard AND that pane's provenance marker.
    const inherited: Record<string, string> = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.quotePath',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_TERMINAL_PROMPT: '1',
      GCM_INTERACTIVE: 'auto'
    }
    applyTerminalGitCredentialPromptGuard(inherited, {
      launchCommand: 'claude',
      platform: process.platform
    })
    const saved = takeGitCredentialGuardEnv(inherited)

    try {
      // Exactly what main puts on the wire for a guarded pane it defers to the daemon.
      const requested: Record<string, string> = {}
      applyTerminalGitCredentialPromptGuard(requested, {
        launchCommand: 'claude',
        platform: process.platform,
        deferGitConfigGuardToHost: true
      })
      await createPtySubprocess({
        sessionId: 'inherited-and-requested-guard',
        cols: 80,
        rows: 24,
        env: { SHELL: '/bin/bash', ...requested }
      })

      const paneEnv = spawnMock.mock.calls.at(-1)?.[2]?.env as Record<string, string>
      // One caller entry plus one guard pair — not two guard pairs.
      expect(paneEnv.GIT_CONFIG_COUNT).toBe('3')
      expect(paneEnv.GIT_CONFIG_KEY_1).toBe('credential.interactive')
      expect(paneEnv.GIT_CONFIG_KEY_2).toBe('credential.guiPrompt')
      expect(paneEnv.GIT_CONFIG_KEY_3).toBeUndefined()

      // And the pane's own marker still describes the user's real pre-guard env,
      // so a plain shell launched inside it lands exactly back on those values.
      const child = { ...paneEnv }
      expect(
        applyTerminalGitCredentialPromptGuard(child, {
          launchCommand: '/bin/zsh',
          platform: process.platform
        })
      ).toBe(false)
      expect(child.GIT_TERMINAL_PROMPT).toBe('1')
      expect(child.GCM_INTERACTIVE).toBe('auto')
      expect(child.GIT_CONFIG_COUNT).toBe('1')
      expect(child.GIT_CONFIG_KEY_0).toBe('core.quotePath')
      expect(Object.values(child)).not.toContain('credential.interactive')
    } finally {
      restoreGitCredentialGuardEnv(saved)
    }
  })
})
