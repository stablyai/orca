import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  encodeShellStartupFeatures,
  selectShellStartupFeatures,
  SHELL_STARTUP_FEATURE_ENV,
  type ShellStartupFeature
} from '../main/shell-startup-features'
import { inheritedZdotdirEnv, resolveInheritedZdotdir } from '../main/zsh-wrapper-dir-ownership'
import { ensureOverlayRestoreWrappers } from './pty-shell-overlay-wrappers'
const RELAY_SHELL_READY_DIR = '.orca-relay/shell-ready'
const POSIX_LOGIN_ARGS = ['-l']

export type RelayShellLaunchConfig = {
  args: string[]
  env: Record<string, string>
  supportsReadyMarker: boolean
}

function shellBasename(shellPath: string): string {
  return shellPath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
}

/** The outer exe of a WSL launch; the shell the user actually types into lives
 *  inside the distro, so history/env handling must look past this name. */
export function isRelayWslShell(
  shellPath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== 'win32') {
    return false
  }
  const name = shellBasename(shellPath)
  return name === 'wsl.exe' || name === 'wsl'
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

function getWrapperRoot(env: Record<string, string>): string {
  return join(env.HOME || process.env.HOME || homedir(), RELAY_SHELL_READY_DIR)
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
  const unwrapped: RelayShellLaunchConfig = {
    args: POSIX_LOGIN_ARGS,
    env: {},
    supportsReadyMarker: false
  }
  if (platform === 'win32') {
    // Why: pwsh also exists on POSIX remotes; Windows-specific shell args must
    // only apply when the relay itself is running on native Windows.
    return {
      args:
        windowsShellArgs(shellName, {
          terminalWindowsWslDistro: options.terminalWindowsWslDistro
        }) ?? [],
      env: {},
      supportsReadyMarker: false
    }
  }

  if (shellName !== 'zsh' && shellName !== 'bash') {
    return unwrapped
  }

  // Why both map to the same flag: the relay only wraps for a startup command
  // when that command's delivery asked for the readiness handshake.
  const startupCommandRequested =
    options.emitReadyMarker === true || options.emitStartupIdentity === true
  const features = selectShellStartupFeatures({
    shellPath: shellName,
    env,
    hasStartupCommand: startupCommandRequested,
    waitsForShellReady: options.emitReadyMarker === true,
    emitsStartupIdentity: options.emitStartupIdentity === true
  })
  // Why bash is always wrapped: its rcfile carries the OSC 133 command-lifecycle
  // hooks unconditionally today, and dropping them would strand agent rows on
  // "working". zsh keeps the plain startup fast path when nothing needs it —
  // the same `features.length` rule the local and daemon transports use.
  if (shellName !== 'bash' && features.length === 0) {
    return unwrapped
  }

  const root = getWrapperRoot(env)
  let wrappersReady = false
  try {
    wrappersReady = ensureOverlayRestoreWrappers(root)
  } catch {
    // Why swallow: a remote HOME can be read-only or root-owned (EACCES), and
    // that must not stop the pane from opening at all.
    wrappersReady = false
  }
  if (!wrappersReady) {
    // Why plain login shell: ZDOTDIR pointed at an incomplete wrapper dir makes
    // zsh skip the user's whole config. Losing Orca's features is recoverable.
    return unwrapped
  }

  const featureEnv = {
    [SHELL_STARTUP_FEATURE_ENV]: encodeShellStartupFeatures(features)
  }
  const supportsReadyMarker = features.includes('ready')

  if (shellName === 'zsh') {
    return {
      args: POSIX_LOGIN_ARGS,
      env: {
        ...inheritedZdotdirEnv(resolveInheritedZdotdir(env)),
        ZDOTDIR: join(root, 'zsh'),
        ...featureEnv
      },
      supportsReadyMarker
    }
  }

  return {
    args: ['--rcfile', join(root, 'bash', 'rcfile')],
    env: featureEnv,
    supportsReadyMarker
  }
}

export type { ShellStartupFeature }
