import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as LocalPtyUtils from '../providers/local-pty-utils'

// Why: the WSL cwd need not exist on the test host; only the chosen shell is asserted.
vi.mock('../providers/local-pty-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof LocalPtyUtils>()),
  resolveUnixShellPath: (shellPath: string) => shellPath,
  ensureNodePtySpawnHelperExecutable: vi.fn(),
  validateWorkingDirectory: vi.fn()
}))

// Why: keep the Windows shell resolution deterministic off Windows and never spawn a pwsh probe.
const { WINDOWS_POWERSHELL_ABS, CMD_ABS } = vi.hoisted(() => ({
  WINDOWS_POWERSHELL_ABS: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  CMD_ABS: 'C:\\Windows\\System32\\cmd.exe'
}))
vi.mock('../pwsh', () => ({
  isPwshAvailable: () => false,
  isPwshAvailableAsync: async () => false,
  warmPwshAvailabilityCache: async () => false
}))
vi.mock('../providers/windows-powershell-executable', () => ({
  resolveWindowsPowerShellExecutablePath: () => WINDOWS_POWERSHELL_ABS,
  resolveWindowsPowerShellSpawnChain: () => [WINDOWS_POWERSHELL_ABS, CMD_ABS],
  getWindowsCmdPath: () => CMD_ABS
}))

import { createPtyShellLaunchPlan } from './pty-subprocess/shell-launch-plan'
import { resolveWslSessionContext } from './wsl-session-context'

const WSL_DOLLAR_CWD = String.raw`\\wsl$\Ubuntu\home\u\p`
const HOST_CWD = String.raw`C:\Users\u\p`
const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value })
}

// Pins main's current launch behaviour as the convergence parity baseline (§7 item 3 / Q1 folder
// panes, rule WINDOW_PANE daemon spawn): a \\wsl$ cwd beats the pane's Windows shell override.
describe('daemon WSL session context for a folder pane on main', () => {
  afterEach(() => {
    if (ORIGINAL_PLATFORM) {
      Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM)
    }
  })

  it.each([
    {
      name: '\\\\wsl$ cwd with powershell.exe',
      cwd: WSL_DOLLAR_CWD,
      shellOverride: 'powershell.exe',
      expected: { distro: 'Ubuntu', treatPosixCwdAsWsl: true }
    },
    {
      name: '\\\\wsl$ cwd with cmd.exe',
      cwd: WSL_DOLLAR_CWD,
      shellOverride: 'cmd.exe',
      expected: { distro: 'Ubuntu', treatPosixCwdAsWsl: true }
    },
    {
      name: 'C:\\ cwd with powershell.exe',
      cwd: HOST_CWD,
      shellOverride: 'powershell.exe',
      expected: undefined
    }
  ])('win32: $name', ({ cwd, shellOverride, expected }) => {
    setPlatform('win32')

    expect(resolveWslSessionContext({ cwd, shellOverride })).toStrictEqual(expected)
  })

  // Why: a \\wsl$ path only reaches a non-Windows daemon through a paired or synced record.
  it.each(['darwin', 'linux'] as const)('%s: a \\\\wsl$ cwd gets no WSL context', (platform) => {
    setPlatform(platform)

    expect(
      resolveWslSessionContext({ cwd: WSL_DOLLAR_CWD, shellOverride: 'powershell.exe' })
    ).toBeUndefined()
  })

  it('win32: the daemon spawns wsl.exe into the distro for a \\\\wsl$ cwd despite powershell.exe', () => {
    setPlatform('win32')

    const plan = createPtyShellLaunchPlan(
      { sessionId: 's', cols: 80, rows: 24, cwd: WSL_DOLLAR_CWD, shellOverride: 'powershell.exe' },
      {}
    )

    expect(plan.shellPath).toBe('wsl.exe')
    expect(plan.shellArgs.slice(0, 5)).toStrictEqual(['-d', 'Ubuntu', '--exec', 'sh', '-c'])
    expect(plan.shellArgs[5]?.startsWith("cd '/home/u/p' && ")).toBe(true)
    expect(plan.validationCwd).toBe(WSL_DOLLAR_CWD)
    expect(plan.windowsFallbackAttempts).toStrictEqual([])
  })

  it('win32: a C:\\ cwd with powershell.exe spawns PowerShell with a cmd.exe fallback', () => {
    setPlatform('win32')

    const plan = createPtyShellLaunchPlan(
      { sessionId: 's', cols: 80, rows: 24, cwd: HOST_CWD, shellOverride: 'powershell.exe' },
      {}
    )

    expect(plan.shellPath).toBe(WINDOWS_POWERSHELL_ABS)
    expect(plan.shellArgs.slice(0, 3)).toStrictEqual(['-NoLogo', '-NoExit', '-EncodedCommand'])
    expect(plan.spawnCwd).toBe(HOST_CWD)
    expect(plan.windowsFallbackAttempts.map((attempt) => attempt.shellPath)).toStrictEqual([
      WINDOWS_POWERSHELL_ABS,
      CMD_ABS
    ])
  })
})
