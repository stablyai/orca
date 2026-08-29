import { tmpdir } from 'node:os'
import { basename, join, win32 as pathWin32 } from 'node:path'
import { statSync } from 'node:fs'
import {
  encodePowerShellCommand,
  getPowerShellOsc133Bootstrap,
  isPowerShellExecutableName
} from '../powershell-osc133-bootstrap'
import { getFishCodexShellLaunchPreflight } from '../pty/codex-shell-launch-preflight'
import { getFishShellReadyInitCommand } from '../shell-templates'
import {
  encodeShellStartupFeatures,
  SHELL_STARTUP_FEATURE_ENV,
  type ShellStartupFeature
} from '../shell-startup-features'
import { resolveShellWrapperRoot } from '../shell-wrapper-content-address'
import { writeShellWrapperFiles } from '../shell-wrapper-file-writer'
import { buildDaemonShellReadyWrapperFiles } from './daemon-shell-ready-wrapper-fileset'
import { inheritedZdotdirEnv, resolveInheritedZdotdir } from '../zsh-wrapper-dir-ownership'
import { SHELL_READY_MARKER } from './daemon-shell-ready-marker'

const ORCA_USER_DATA_PATH_ENV = 'ORCA_USER_DATA_PATH'

function getShellReadyWrapperBaseDir(): string {
  const userDataPath = process.env[ORCA_USER_DATA_PATH_ENV]
  // Why a base dir of its own rather than the legacy `shell-ready/`: daemons of
  // older builds still write that path unconditionally, so leaving it to them
  // keeps this build's content-addressed trees out of their reach.
  // Why the tmpdir fallback: older/test launchers may not seed
  // ORCA_USER_DATA_PATH, and daemon startup must not fail before the parent can
  // be fixed. It is dev/test-only -- daemon-init always passes the real path --
  // which matters because the presence check is size-only, so a complete tree
  // pre-planted under a shared /tmp would be trusted rather than overwritten.
  return join(userDataPath || tmpdir(), userDataPath ? 'shell-wrappers' : 'orca-shell-wrappers')
}

// Why memoized and keyed on the base dir: the digest is stable for a given base
// dir, every shell launch asks for it, and the key self-invalidates if
// ORCA_USER_DATA_PATH is ever re-pointed mid-process.
let cachedShellReadyWrapperRoot: { baseDir: string; root: string } | null = null

export function getShellReadyWrapperRoot(): string {
  const baseDir = getShellReadyWrapperBaseDir()
  if (cachedShellReadyWrapperRoot?.baseDir !== baseDir) {
    cachedShellReadyWrapperRoot = {
      baseDir,
      root: resolveShellWrapperRoot(baseDir, buildDaemonShellReadyWrapperFiles)
    }
  }
  return cachedShellReadyWrapperRoot.root
}

function getRequiredShellReadyWrapperPaths(root = getShellReadyWrapperRoot()): string[] {
  return buildDaemonShellReadyWrapperFiles(root).map(([path]) => path)
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
  const root = getShellReadyWrapperRoot()
  // Why existence alone decides, with no per-process flag: the root is keyed by
  // a hash of the exact bytes we would write, so a tree that is present and
  // non-empty is a tree this build wrote. Rewriting it would replace a live file
  // on the terminal-spawn path for no gain.
  if (!shellReadyWrappersExist()) {
    const written = writeShellWrapperFiles(
      buildDaemonShellReadyWrapperFiles(root),
      '[daemon/shell-ready]'
    )
    if (!written || !shellReadyWrappersExist()) {
      // Why no flag to reset: the next launch re-checks the files themselves, so
      // a half-written tree is retried without any extra bookkeeping.
      return false
    }
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
        ...inheritedZdotdirEnv(resolveInheritedZdotdir(process.env)),
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
