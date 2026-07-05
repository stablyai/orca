import type { IPty } from 'node-pty'
import type * as NodePty from 'node-pty'
import { win32 as pathWin32 } from 'node:path'
import {
  resolveWindowsPowerShellShellPath,
  resolveWindowsTerminalLaunchPlan,
  resolveWindowsTerminalShellPath,
  shouldLaunchWindowsPowerShellWithoutProfile,
  type WindowsPowerShellImplementation,
  type WindowsShellSpawnAttempt
} from '../shared/windows-terminal-launch-plan'
import { WINDOWS_GIT_BASH_SHELL } from '../shared/windows-terminal-shell'
import {
  formatWindowsPowerShellCrashCorrelationHint,
  formatWindowsPowerShellSpawnDiagnostic,
  getWindowsPowerShellFallbackStartupDelivery
} from '../shared/windows-powershell-spawn-diagnostics'

export type RelayShellLaunch = {
  args: string[]
  env: Record<string, string>
}

export type RelaySpawnResult = {
  shellLaunch: RelayShellLaunch
  startupCommandDeliveredInShellArgs: boolean
  term: IPty
}

const ALLOWED_WINDOWS_SHELL_OVERRIDES = new Set([
  'powershell.exe',
  'powershell',
  'pwsh.exe',
  'pwsh',
  'cmd.exe',
  'cmd',
  'wsl.exe',
  'wsl',
  WINDOWS_GIT_BASH_SHELL
])

export function isWindowsPowerShellRelayShell(shellPath: string): boolean {
  const shellName = shellPath.replace(/\\/g, '/').split('/').pop()?.toLowerCase()
  return (
    shellName === 'powershell.exe' ||
    shellName === 'powershell' ||
    shellName === 'pwsh.exe' ||
    shellName === 'pwsh'
  )
}

export function readWindowsPowerShellImplementation(
  value: unknown
): WindowsPowerShellImplementation | undefined {
  return value === 'auto' || value === 'powershell.exe' || value === 'pwsh.exe' ? value : undefined
}

function readWindowsPathEnv(env: Record<string, string>): string {
  return env.PATH || env.Path || env.path || ''
}

function getEnvWithWindowsShellDirectory(
  env: Record<string, string>,
  shellPath: string
): Record<string, string> {
  if (!pathWin32.isAbsolute(shellPath)) {
    return env
  }
  const shellDir = pathWin32.dirname(shellPath)
  const pathValue = readWindowsPathEnv(env)
  return {
    ...env,
    PATH: pathValue ? `${shellDir}${pathWin32.delimiter}${pathValue}` : shellDir
  }
}

export function resolveWindowsPowerShellConfiguredShell(
  shellPath: string,
  powerShellImplementation?: WindowsPowerShellImplementation
): string {
  const resolvedShell = resolveWindowsTerminalShellPath({
    shellPath,
    powerShellImplementation,
    pwshAvailable:
      powerShellImplementation === undefined
        ? false
        : () => resolveWindowsPowerShellShellPath('pwsh.exe') !== null
  })
  return resolveWindowsPowerShellShellPath(resolvedShell) ?? resolvedShell
}

export function resolvePtyShellOverride(
  shellOverride: string,
  powerShellImplementation?: WindowsPowerShellImplementation
): string {
  if (!shellOverride) {
    return ''
  }
  if (process.platform !== 'win32') {
    return ''
  }
  const normalized = shellOverride.toLowerCase()
  if (!ALLOWED_WINDOWS_SHELL_OVERRIDES.has(normalized)) {
    throw new Error(`Unsupported Windows shell override: ${shellOverride}`)
  }
  // Why: relay spawns directly, without the local/daemon fallback wrapper.
  // Resolve PowerShell families to real executables before node-pty sees them.
  return resolveWindowsPowerShellConfiguredShell(shellOverride, powerShellImplementation)
}

function getRelayPtySpawnEnv(
  baseEnv: Record<string, string>,
  launchEnv: Record<string, string>,
  shellPath: string
): Record<string, string> {
  const env = { ...baseEnv, ORCA_SHELL_READY_MARKER: '0', ...launchEnv }
  if (
    process.platform === 'win32' &&
    !isWindowsPowerShellRelayShell(shellPath) &&
    launchEnv.ORCA_SHELL_READY_MARKER === '1'
  ) {
    delete (env as Partial<Record<string, string>>).ORCA_SHELL_READY_MARKER
  }
  return env
}

export function getWindowsRelayFallbackAttempts(args: {
  command?: string
  cwd: string
  shell: string
  shouldProviderDeliverCommand: boolean
  spawnEnv: Record<string, string>
}): WindowsShellSpawnAttempt[] {
  if (process.platform !== 'win32' || !isWindowsPowerShellRelayShell(args.shell)) {
    return []
  }
  return resolveWindowsTerminalLaunchPlan({
    shellPath: args.shell,
    cwd: args.cwd,
    defaultCwd: args.cwd,
    startupCommand: args.shouldProviderDeliverCommand ? args.command : undefined,
    launchOptions: {
      powerShellNoProfile: shouldLaunchWindowsPowerShellWithoutProfile(args.spawnEnv)
    },
    resolveOptions: {
      env: getEnvWithWindowsShellDirectory(args.spawnEnv, args.shell),
      platform: 'win32'
    }
  }).windowsFallbackAttempts
}

export function spawnRelayPtyWithWindowsFallback(args: {
  cols: number
  cwd: string
  pty: typeof NodePty
  rows: number
  shell: string
  shellLaunch: RelayShellLaunch
  spawnEnv: Record<string, string>
  windowsFallbackAttempts: WindowsShellSpawnAttempt[]
}): RelaySpawnResult {
  const spawnAt = (shell: string, launch: RelayShellLaunch, cwd: string): IPty =>
    args.pty.spawn(shell, launch.args, {
      name: 'xterm-256color',
      cols: args.cols,
      rows: args.rows,
      cwd,
      // Why: relay shells inherit process.env; never let an ambient Orca marker
      // enable shell-ready behavior unless this spawn explicitly requested it.
      env: getRelayPtySpawnEnv(args.spawnEnv, launch.env, shell)
    })

  try {
    return {
      shellLaunch: args.shellLaunch,
      startupCommandDeliveredInShellArgs: false,
      term: spawnAt(args.shell, args.shellLaunch, args.cwd)
    }
  } catch (primaryErr) {
    if (process.platform !== 'win32') {
      throw primaryErr
    }
    const message = primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
    for (const attempt of args.windowsFallbackAttempts.slice(1)) {
      const launch = {
        args: attempt.shellArgs,
        env: args.shellLaunch.env.ORCA_SHELL_READY_MARKER === '1' ? args.shellLaunch.env : {}
      }
      try {
        const term = spawnAt(attempt.shellPath, launch, attempt.effectiveCwd)
        console.warn(
          [
            `[relay/pty] Primary shell "${args.shell}" failed (${message}), fell back to "${attempt.shellPath}"`,
            formatWindowsPowerShellSpawnDiagnostic({
              fallbackFromShellPath: args.shell,
              shellPath: attempt.shellPath,
              startupDelivery: getWindowsPowerShellFallbackStartupDelivery({
                shellReadyMarker: args.shellLaunch.env.ORCA_SHELL_READY_MARKER,
                startupCommandDeliveredInShellArgs: attempt.startupCommandDeliveredInShellArgs
              }),
              safeModeNoProfile: args.spawnEnv.ORCA_WINDOWS_POWERSHELL_SAFE_MODE === '1'
            }),
            formatWindowsPowerShellCrashCorrelationHint({ shellPath: args.shell })
          ].join('; ')
        )
        return {
          shellLaunch: launch,
          startupCommandDeliveredInShellArgs: attempt.startupCommandDeliveredInShellArgs,
          term
        }
      } catch {
        // This fallback shell also failed -- try the next link in the chain.
      }
    }
    throw primaryErr
  }
}
