import { tmpdir } from 'node:os'
import { basename, dirname, join, win32 as pathWin32 } from 'node:path'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import {
  encodePowerShellCommand,
  getPowerShellOsc133Bootstrap,
  isPowerShellExecutableName
} from '../powershell-osc133-bootstrap'
import { getFishCodexShellLaunchPreflight } from '../pty/codex-shell-launch-preflight'
import { getFishShellReadyInitCommand } from '../shell-templates'
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

// Why: if our own process inherited ZDOTDIR from a parent shell that was
// itself an Orca PTY (e.g. the user launched Orca from a terminal inside a
// running Orca), that ZDOTDIR points at an Orca shell-ready wrapper dir.
// Propagating it as the new PTY's ORCA_ORIG_ZDOTDIR makes the wrapper's
// `source "$ORCA_ORIG_ZDOTDIR/.zshenv"` line source itself recursively —
// zsh gives "job table full or recursion limit exceeded" and the shell
// never reaches a usable prompt.
//
// Any path component ending in `/shell-ready/zsh` is an Orca wrapper dir
// (regardless of whether it came from this daemon's userData, a packaged
// Orca, or a different dev build). Treat it as if ZDOTDIR were unset so the
// caller falls back to HOME for the user's real config root.
function normalizeOriginalZdotdirCandidate(value: string | undefined): string | null {
  if (!value) {
    return null
  }
  // Why: tolerate trailing slashes — some shell startup scripts export
  // `ZDOTDIR="$dir/"`, and without normalization the suffix check would
  // miss the self-loop path and restore the recursion bug. Also collapses
  // a pathological `ZDOTDIR=/` to empty so we fall back to HOME rather than
  // sourcing `/.zshenv` (which is never the user's real config).
  const normalized = value.replace(/\/+$/, '')
  if (!normalized || normalized.endsWith('/shell-ready/zsh')) {
    return null
  }
  return value
}

function resolveOriginalZdotdir(): string {
  return (
    normalizeOriginalZdotdirCandidate(process.env.ZDOTDIR) ||
    normalizeOriginalZdotdirCandidate(process.env.ORCA_ORIG_ZDOTDIR) ||
    process.env.HOME ||
    ''
  )
}

function resolveOriginalZshenvSourceDir(): string {
  return normalizeOriginalZdotdirCandidate(process.env.ZDOTDIR) || process.env.HOME || ''
}

function getRequiredShellReadyWrapperPaths(root = getShellReadyWrapperRoot()): string[] {
  return [
    join(root, 'zsh', '.zshenv'),
    join(root, 'zsh', '.zprofile'),
    join(root, 'zsh', '.zshrc'),
    join(root, 'zsh', '.zlogin'),
    join(root, 'bash', 'rcfile')
  ]
}

function shellReadyWrappersExist(): boolean {
  return getRequiredShellReadyWrapperPaths().every((path) => existsSync(path))
}

function ensureShellReadyWrappers(): void {
  if (process.platform === 'win32') {
    return
  }
  if (didEnsureShellReadyWrappers && shellReadyWrappersExist()) {
    return
  }
  didEnsureShellReadyWrappers = true

  const root = getShellReadyWrapperRoot()
  const zshDir = join(root, 'zsh')
  const bashDir = join(root, 'bash')

  const zsh = buildZshStartupWrapperFiles(getDaemonZshWrapperSpec(zshDir))
  const bashRc = getDaemonBashShellReadyRcfileContent()

  const files = [
    [join(zshDir, '.zshenv'), zsh.zshenv],
    [join(zshDir, '.zprofile'), zsh.zprofile],
    [join(zshDir, '.zshrc'), zsh.zshrc],
    [join(zshDir, '.zlogin'), zsh.zlogin],
    [join(bashDir, 'rcfile'), bashRc]
  ] as const

  try {
    for (const [path, content] of files) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content, 'utf8')
      chmodSync(path, 0o644)
    }
  } catch (error) {
    // Why: wrapper file creation can fail due to read-only filesystems, permission
    // issues, or disk space. Rather than crashing, log the error and continue.
    // The shell will launch without the wrapper, which means no shell-ready marker
    // but at least the PTY is usable.
    const errorMessage =
      error instanceof Error
        ? `${error.message} (${(error as NodeJS.ErrnoException).code || 'unknown'})`
        : String(error)
    console.error(`[daemon/shell-ready] Failed to create wrapper files in ${root}: ${errorMessage}`)
    console.error('[daemon/shell-ready] Shell will launch without wrapper (no shell-ready marker)')
    // Reset the flag so next attempt will try again
    didEnsureShellReadyWrappers = false
  }
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

type ShellLaunchConfig = {
  args: string[] | null
  env: Record<string, string>
  supportsReadyMarker: boolean
}

function getWrappedShellLaunchConfig(
  shellPath: string,
  options: { emitReadyMarker: boolean }
): ShellLaunchConfig {
  const shellName = pathWin32.basename(basename(shellPath)).toLowerCase()

  if (shellName === 'zsh') {
    ensureShellReadyWrappers()
    const root = getShellReadyWrapperRoot()
    return {
      args: ['-l'],
      env: {
        ORCA_ORIG_ZDOTDIR: resolveOriginalZdotdir(),
        ORCA_ZSHENV_SOURCE_DIR: resolveOriginalZshenvSourceDir(),
        ZDOTDIR: join(root, 'zsh'),
        ORCA_SHELL_READY_MARKER: options.emitReadyMarker ? '1' : '0',
        ORCA_SHELL_STARTUP_IDENTITY: options.emitReadyMarker ? '1' : '0'
      },
      supportsReadyMarker: options.emitReadyMarker
    }
  }

  if (shellName === 'bash') {
    ensureShellReadyWrappers()
    const root = getShellReadyWrapperRoot()
    return {
      args: ['--rcfile', join(root, 'bash', 'rcfile')],
      env: {
        ORCA_SHELL_READY_MARKER: options.emitReadyMarker ? '1' : '0',
        ORCA_SHELL_STARTUP_IDENTITY: options.emitReadyMarker ? '1' : '0'
      },
      supportsReadyMarker: options.emitReadyMarker
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

  // Why: mirrors local-pty-shell-ready.ts; markerless fish stays unwrapped.
  if (shellName === 'fish' && options.emitReadyMarker) {
    return {
      args: [
        '-l',
        '-C',
        `${getFishShellReadyInitCommand(SHELL_READY_MARKER)}\n${getFishCodexShellLaunchPreflight()}`
      ],
      env: { ORCA_SHELL_READY_MARKER: '1' },
      supportsReadyMarker: true
    }
  }

  return {
    args: null,
    env: {},
    supportsReadyMarker: false
  }
}

export function getShellReadyLaunchConfig(shellPath: string): ShellLaunchConfig {
  return getWrappedShellLaunchConfig(shellPath, { emitReadyMarker: true })
}

export function getMarkerlessShellLaunchConfig(shellPath: string): ShellLaunchConfig {
  return getWrappedShellLaunchConfig(shellPath, { emitReadyMarker: false })
}
