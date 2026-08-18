import { tmpdir } from 'node:os'
import { basename, join, win32 as pathWin32 } from 'node:path'
import { statSync } from 'node:fs'
import {
  encodePowerShellCommand,
  getPowerShellOsc133Bootstrap,
  isPowerShellExecutableName
} from '../powershell-osc133-bootstrap'
import { getFishCodexShellLaunchPreflight } from '../pty/codex-shell-launch-preflight'
import {
  getFishShellReadyInitCommand,
  ZSH_WRAPPER_DIR_MARKER_CONTENT,
  ZSH_WRAPPER_DIR_MARKER_FILE
} from '../shell-templates'
import {
  encodeShellStartupFeatures,
  SHELL_STARTUP_FEATURE_ENV,
  type ShellStartupFeature
} from '../shell-startup-features'
import { writeShellWrapperFiles } from '../shell-wrapper-file-writer'
import {
  resolveInheritedZdotdir,
  resolveInheritedZshenvSourceDir
} from '../zsh-wrapper-dir-ownership'
import { buildZshStartupWrapperFiles } from '../zsh-startup-wrapper-builder'
import { SHELL_READY_MARKER } from './daemon-shell-ready-marker'
import { getDaemonBashShellReadyRcfileContent } from './daemon-bash-shell-ready-rcfile'
import { getDaemonZshWrapperSpec } from './daemon-zsh-shell-ready-wrapper-spec'

const ORCA_USER_DATA_PATH_ENV = 'ORCA_USER_DATA_PATH'

let didEnsureShellReadyWrappers = false

function getShellReadyWrapperRoot(): string {
  const userDataPath = process.env[ORCA_USER_DATA_PATH_ENV]
  // Why: older/test launchers may not seed ORCA_USER_DATA_PATH. Keep a
  // fallback so daemon startup does not fail before the parent can be fixed.
  return join(userDataPath || tmpdir(), userDataPath ? 'shell-ready' : 'orca-shell-ready')
}

function getRequiredShellReadyWrapperPaths(root = getShellReadyWrapperRoot()): string[] {
  return [
    join(root, 'zsh', '.zshenv'),
    join(root, 'zsh', '.zprofile'),
    join(root, 'zsh', '.zshrc'),
    join(root, 'zsh', '.zlogin'),
    join(root, 'zsh', ZSH_WRAPPER_DIR_MARKER_FILE),
    join(root, 'bash', 'rcfile')
  ]
}

// Why non-empty and not just present: a partial write leaves a zero-byte
// .zshenv, and pointing ZDOTDIR at that dir makes zsh skip the user's config.
function shellReadyWrappersExist(): boolean {
  return getRequiredShellReadyWrapperPaths().every((path) => {
    try {
      return statSync(path).size > 0
    } catch {
      return false
    }
  })
}

/** True when every wrapper file is present and non-empty afterwards. */
function ensureShellReadyWrappers(): boolean {
  if (process.platform === 'win32') {
    return false
  }
  if (didEnsureShellReadyWrappers && shellReadyWrappersExist()) {
    return true
  }
  didEnsureShellReadyWrappers = true

  const root = getShellReadyWrapperRoot()
  const zshDir = join(root, 'zsh')
  const zsh = buildZshStartupWrapperFiles(getDaemonZshWrapperSpec(zshDir))

  const written = writeShellWrapperFiles(
    [
      [join(zshDir, '.zshenv'), zsh.zshenv],
      [join(zshDir, '.zprofile'), zsh.zprofile],
      [join(zshDir, '.zshrc'), zsh.zshrc],
      [join(zshDir, '.zlogin'), zsh.zlogin],
      [join(zshDir, ZSH_WRAPPER_DIR_MARKER_FILE), ZSH_WRAPPER_DIR_MARKER_CONTENT],
      [join(root, 'bash', 'rcfile'), getDaemonBashShellReadyRcfileContent()]
    ],
    '[daemon/shell-ready]'
  )
  if (!written || !shellReadyWrappersExist()) {
    // Why reset: the next launch retries instead of trusting a half-written tree.
    didEnsureShellReadyWrappers = false
    return false
  }
  return true
}

export function resolvePtyShellPath(env: Record<string, string>): string {
  if (process.platform === 'win32') {
    return env.ORCA_TERMINAL_WINDOWS_SHELL || 'powershell.exe'
  }
  return env.SHELL || process.env.SHELL || '/bin/zsh'
}

export function shellPathSupportsPtyStartupBarrier(shellPath: string): boolean {
  const shellName = pathWin32.basename(basename(shellPath)).toLowerCase()
  // Why fish: markerless, its startup command is written before fish's reader owns
  // the PTY and the launch is lost under slow prompts like Starship (STA-3417).
  return shellName === 'zsh' || shellName === 'bash' || shellName === 'fish'
}

export function supportsPtyStartupBarrier(env: Record<string, string>): boolean {
  if (process.platform === 'win32') {
    return false
  }
  return shellPathSupportsPtyStartupBarrier(resolvePtyShellPath(env))
}

export type ShellLaunchConfig = {
  args: string[] | null
  env: Record<string, string>
  supportsReadyMarker: boolean
}

const UNWRAPPED: ShellLaunchConfig = {
  args: null,
  env: {},
  supportsReadyMarker: false
}

/**
 * The one launch-config entry point: args + env for a shell that should start
 * with exactly `features` enabled. An empty selection is never wrapped.
 */
export function getShellLaunchConfig(
  shellPath: string,
  features: readonly ShellStartupFeature[]
): ShellLaunchConfig {
  const shellName = pathWin32.basename(basename(shellPath)).toLowerCase()

  if (shellName === 'zsh') {
    if (features.length === 0) {
      return UNWRAPPED
    }
    if (!ensureShellReadyWrappers()) {
      // Why plain login zsh: ZDOTDIR pointed at an incomplete wrapper dir makes
      // zsh skip the user's whole config. Losing Orca's features is recoverable.
      return { args: ['-l'], env: {}, supportsReadyMarker: false }
    }
    return {
      args: ['-l'],
      env: {
        ORCA_ORIG_ZDOTDIR: resolveInheritedZdotdir(process.env),
        ORCA_ZSHENV_SOURCE_DIR: resolveInheritedZshenvSourceDir(process.env),
        ZDOTDIR: join(getShellReadyWrapperRoot(), 'zsh'),
        [SHELL_STARTUP_FEATURE_ENV]: encodeShellStartupFeatures(features)
      },
      supportsReadyMarker: features.includes('ready')
    }
  }

  if (shellName === 'bash') {
    if (features.length === 0 || !ensureShellReadyWrappers()) {
      return UNWRAPPED
    }
    return {
      args: ['--rcfile', join(getShellReadyWrapperRoot(), 'bash', 'rcfile')],
      env: {
        [SHELL_STARTUP_FEATURE_ENV]: encodeShellStartupFeatures(features)
      },
      supportsReadyMarker: features.includes('ready')
    }
  }

  if (isPowerShellExecutableName(shellName)) {
    return {
      args: [
        '-NoLogo',
        '-NoExit',
        '-EncodedCommand',
        encodePowerShellCommand(getPowerShellOsc133Bootstrap())
      ],
      env: {},
      supportsReadyMarker: false
    }
  }

  // Why: mirrors local-pty-shell-ready.ts; markerless fish stays unwrapped. The
  // selection is baked into the init command, so fish needs no feature env var.
  if (shellName === 'fish' && features.includes('ready')) {
    return {
      args: [
        '-l',
        '-C',
        `${getFishShellReadyInitCommand(SHELL_READY_MARKER)}\n${getFishCodexShellLaunchPreflight()}`
      ],
      env: {},
      supportsReadyMarker: true
    }
  }

  return UNWRAPPED
}
