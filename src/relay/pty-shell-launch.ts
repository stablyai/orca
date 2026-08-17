import { homedir } from 'node:os'
import { join } from 'node:path'
import { ensureOverlayRestoreWrappers } from './pty-shell-overlay-wrappers'
const RELAY_SHELL_READY_DIR = '.orca-relay/shell-ready'
const POSIX_LOGIN_ARGS = ['-l']

export type RelayShellLaunchConfig = {
  args: string[]
  env: Record<string, string>
}

function shellBasename(shellPath: string): string {
  return shellPath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
}

function windowsShellArgs(
  shellName: string,
  options: { terminalWindowsWslDistro?: string | null } = {}
): string[] | null {
  if (shellName === 'powershell.exe' || shellName === 'powershell') {
    return ['-NoLogo']
  }
  if (shellName === 'pwsh.exe' || shellName === 'pwsh') {
    return ['-NoLogo']
  }
  if (shellName === 'cmd.exe' || shellName === 'cmd') {
    return []
  }
  if (shellName === 'wsl.exe' || shellName === 'wsl') {
    const distro = options.terminalWindowsWslDistro?.trim()
    return distro ? ['-d', distro] : []
  }
  return null
}

function hasOverlayRestoreEnv(env: Record<string, string>): boolean {
  return Boolean(
    env.ORCA_OPENCODE_CONFIG_DIR ||
    env.ORCA_MIMOCODE_HOME ||
    env.ORCA_REMOTE_CLI_BIN_DIR ||
    env.ORCA_OMP_STATUS_EXTENSION
  )
}

function getWrapperRoot(env: Record<string, string>): string {
  return join(env.HOME || process.env.HOME || homedir(), RELAY_SHELL_READY_DIR)
}

function normalizeOriginalZdotdirCandidate(value: string | undefined): string | null {
  if (!value) {
    return null
  }
  const normalized = value.replace(/\/+$/, '')
  if (!normalized || normalized.endsWith('/shell-ready/zsh')) {
    return null
  }
  return value
}

function resolveOriginalZdotdir(env: Record<string, string>): string {
  return (
    normalizeOriginalZdotdirCandidate(env.ZDOTDIR) ||
    normalizeOriginalZdotdirCandidate(env.ORCA_ORIG_ZDOTDIR) ||
    env.HOME ||
    process.env.HOME ||
    ''
  )
}

export function getRelayShellLaunchConfig(
  shellPath: string,
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
  options: {
    emitReadyMarker?: boolean
    emitStartupIdentity?: boolean
    terminalWindowsWslDistro?: string | null
  } = {}
): RelayShellLaunchConfig {
  const shellName = shellBasename(shellPath)
  const emitReadyMarker = options.emitReadyMarker === true
  const emitStartupIdentity = options.emitStartupIdentity === true
  if (platform === 'win32') {
    // Why: pwsh also exists on POSIX remotes; Windows-specific shell args must
    // only apply when the relay itself is running on native Windows.
    return {
      args:
        windowsShellArgs(shellName, {
          terminalWindowsWslDistro: options.terminalWindowsWslDistro
        }) ?? [],
      env: {}
    }
  }

  if (shellName !== 'zsh' && shellName !== 'bash') {
    return { args: POSIX_LOGIN_ARGS, env: {} }
  }
  // Why: preserve plain zsh startup fast path unless markers or overlay restoration are requested.
  const requiresZshWrapper = hasOverlayRestoreEnv(env) || emitReadyMarker || emitStartupIdentity
  if (shellName === 'zsh' && !requiresZshWrapper) {
    return { args: POSIX_LOGIN_ARGS, env: {} }
  }

  const root = getWrapperRoot(env)
  ensureOverlayRestoreWrappers(root)

  if (shellName === 'zsh') {
    return {
      args: POSIX_LOGIN_ARGS,
      env: {
        ORCA_ORIG_ZDOTDIR: resolveOriginalZdotdir(env),
        ZDOTDIR: join(root, 'zsh'),
        ...(emitReadyMarker ? { ORCA_SHELL_READY_MARKER: '1' } : {}),
        ...(emitStartupIdentity ? { ORCA_SHELL_STARTUP_IDENTITY: '1' } : {})
      }
    }
  }

  return {
    args: ['--rcfile', join(root, 'bash', 'rcfile')],
    env: {
      ...(emitReadyMarker ? { ORCA_SHELL_READY_MARKER: '1' } : {}),
      ...(emitStartupIdentity ? { ORCA_SHELL_STARTUP_IDENTITY: '1' } : {})
    }
  }
}
