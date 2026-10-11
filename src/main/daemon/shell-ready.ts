import { tmpdir } from 'node:os'
import { basename, join, win32 as pathWin32 } from 'node:path'
import { statSync } from 'node:fs'
import {
  encodePowerShellCommand,
  getPowerShellOsc133Bootstrap,
  isPowerShellExecutableName
} from '../powershell-osc133-bootstrap'
import { getFishCodexShellLaunchPreflight } from '../../shared/codex-shell-function'
import { getFishClaudeShellFunction } from '../../shared/claude-shell-function'
import { getFishXdgDataDirsLaunchEnv } from '../fish-xdg-data-dirs-handoff'
import { getFishShellReadyInitCommand } from '../shell-templates'
import {
  encodeShellStartupFeatures,
  SHELL_STARTUP_FEATURE_ENV,
  type ShellStartupFeature
} from '../shell-startup-features'
import { resolveShellWrapperRoot } from '../shell-wrapper-content-address'
import { writeShellWrapperFiles } from '../shell-wrapper-file-writer'
import {
  buildDaemonShellReadyWrapperFiles,
  getDaemonShellReadyWrapperPaths
} from './daemon-shell-ready-wrapper-fileset'
import { inheritedZdotdirEnv, resolveInheritedZdotdir } from '../zsh-wrapper-dir-ownership'
import { SHELL_READY_MARKER } from './daemon-shell-ready-marker'

const ORCA_USER_DATA_PATH_ENV = 'ORCA_USER_DATA_PATH'

function getShellReadyWrapperBaseDir(): string {
  const userDataPath = process.env[ORCA_USER_DATA_PATH_ENV]
  // Isolate content-addressed trees from older daemons that overwrite the legacy shell-ready directory.
  // Temp fallback serves old/test launchers; production supplies ORCA_USER_DATA_PATH.
  // Only file sizes are checked, so do not use the shared-temp fallback in production.
  return join(userDataPath || tmpdir(), userDataPath ? 'shell-wrappers' : 'orca-shell-wrappers')
}

// Cache the digest per base directory so changing ORCA_USER_DATA_PATH selects a fresh root.
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

function getRequiredShellReadyWrapperPaths(root = getShellReadyWrapperRoot()): readonly string[] {
  return getDaemonShellReadyWrapperPaths(root)
}

// A zero-byte .zshenv can suppress user config, so mere file presence is insufficient.
function shellReadyWrappersExist(): boolean {
  return getRequiredShellReadyWrapperPaths().every((path) => {
    try {
      return statSync(path).size > 0
    } catch {
      return false
    }
  })
}

function ensureShellReadyWrappers(): boolean {
  if (process.platform === 'win32') {
    return false
  }
  const root = getShellReadyWrapperRoot()
  // Reuse nonempty files at the content-derived path to avoid replacing live wrappers on each spawn.
  if (!shellReadyWrappersExist()) {
    const written = writeShellWrapperFiles(
      buildDaemonShellReadyWrapperFiles(root),
      '[daemon/shell-ready]'
    )
    if (!written || !shellReadyWrappersExist()) {
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

/** Resolve the requested Unix shell before executable fallback. */
export function resolveUnixPaneShellPath(
  env: Record<string, string>,
  shellOverride: string | undefined,
  defaultShell: string | undefined
): string {
  return shellOverride || defaultShell?.trim() || resolvePtyShellPath(env)
}

export function shellPathSupportsPtyStartupBarrier(shellPath: string): boolean {
  // Why win32 first: Windows pwsh startup commands ride the launch args, so
  // gating its stdin would hold the pane with no marker ever coming.
  if (process.platform === 'win32') {
    return false
  }
  const shellName = pathWin32.basename(basename(shellPath)).toLowerCase()
  // Why fish: markerless, its startup command is written before fish's reader owns
  // the PTY and the launch is lost under slow prompts like Starship (STA-3417).
  // Why pwsh: its .NET console queries the cursor position during startup and
  // reads stdin while waiting for the reply, so a command typed into the startup
  // window loses its Enter and never runs (#27293). The OSC 133 bootstrap emits
  // the ready marker from the prompt function, so the queue releases only once
  // PSReadLine owns the input.
  return (
    shellName === 'zsh' ||
    shellName === 'bash' ||
    shellName === 'fish' ||
    isPowerShellExecutableName(shellName)
  )
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

export function getShellLaunchConfig(
  shellPath: string,
  features: readonly ShellStartupFeature[],
  options?: {
    hasStartupCommand?: boolean
    inheritedXdgDataDirs: string | undefined
    shellArgs?: readonly string[]
  }
): ShellLaunchConfig {
  const shellName = pathWin32.basename(basename(shellPath)).toLowerCase()

  if (shellName === 'zsh') {
    if (features.length === 0) {
      return UNWRAPPED
    }
    if (!ensureShellReadyWrappers()) {
      // Fall back rather than point ZDOTDIR at incomplete wrappers that suppress user config.
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
    // Why no marker on win32: Windows pwsh startup commands ride the launch args
    // (see windows-shell-args.ts), so nothing queues behind a marker there.
    const supportsReadyMarker = process.platform !== 'win32' && features.includes('ready')
    return {
      args: [
        '-NoLogo',
        '-NoExit',
        // Why base64 and not -Command: see powershell-osc133-bootstrap.ts (MDE review).
        '-EncodedCommand',
        encodePowerShellCommand(getPowerShellOsc133Bootstrap())
      ],
      // Why feature-gated: the bootstrap reads this to decide whether the prompt
      // function publishes the ready marker, and removes the variable before any
      // child process can inherit it.
      env: supportsReadyMarker
        ? { [SHELL_STARTUP_FEATURE_ENV]: encodeShellStartupFeatures(features) }
        : {},
      supportsReadyMarker
    }
  }

  // Startup fish embeds feature selection in -C; plain panes use the environment handoff below.
  if (shellName === 'fish' && (features.includes('ready') || options?.hasStartupCommand)) {
    return {
      args: [
        '-l',
        '-C',
        `${getFishShellReadyInitCommand(SHELL_READY_MARKER, features.includes('ready'))}\n${getFishCodexShellLaunchPreflight() + getFishClaudeShellFunction()}`
      ],
      env: {},
      supportsReadyMarker: features.includes('ready')
    }
  }

  // Preserve plain fish argv by delivering integrations through its environment.
  if (shellName === 'fish' && ensureShellReadyWrappers()) {
    return {
      args: null,
      env: getFishXdgDataDirsLaunchEnv(
        getShellReadyWrapperRoot(),
        options?.inheritedXdgDataDirs,
        options?.shellArgs
      ),
      supportsReadyMarker: false
    }
  }

  return UNWRAPPED
}
