/**
 * Shell-ready launch configuration for local PTYs.
 *
 * Why: startup commands must wait until the shell has fully initialized. Picks the args/env
 * that point each shell at its Orca wrapper (which emits the OSC 777 marker the scanner detects).
 */
import { basename, win32 as pathWin32 } from 'node:path'
import {
  encodePowerShellCommand,
  getPowerShellOsc133Bootstrap,
  isPowerShellExecutableName
} from '../powershell-osc133-bootstrap'
import { getFishCodexShellLaunchPreflight } from '../pty/codex-shell-launch-preflight'
import { getFishShellReadyInitCommand } from '../shell-templates'
import { ensureShellReadyWrappers } from './local-pty-shell-ready-wrapper-generation'
import {
  getShellReadyWrapperRoot,
  SHELL_READY_MARKER_ESCAPED
} from './local-pty-shell-ready-wrapper-root'
export {
  createShellReadyScanState,
  drainShellReadyHeldBytes,
  scanForShellReady,
  SHELL_READY_MARKER_PREFIX
} from '../shell-ready-marker-scanner'
export type { ShellReadyScanResult, ShellReadyScanState } from '../shell-ready-marker-scanner'

// Why: an Orca wrapper ZDOTDIR recurses; treat it as unset and fall back to HOME.
function normalizeOriginalZdotdirCandidate(value: string | undefined): string | null {
  if (!value) {
    return null
  }
  // Why: strip trailing slashes so wrapper paths match; `/` falls back to HOME.
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

export type ShellReadyLaunchConfig = {
  args: string[] | null
  env: Record<string, string>
  supportsReadyMarker: boolean
}

function getWrappedShellLaunchConfig(
  shellPath: string,
  options: { emitReadyMarker: boolean }
): ShellReadyLaunchConfig {
  const shellName = pathWin32.basename(basename(shellPath)).toLowerCase()

  if (shellName === 'zsh') {
    ensureShellReadyWrappers()
    return {
      args: ['-l'],
      env: {
        ORCA_ORIG_ZDOTDIR: resolveOriginalZdotdir(),
        ORCA_ZSHENV_SOURCE_DIR: resolveOriginalZshenvSourceDir(),
        ZDOTDIR: `${getShellReadyWrapperRoot()}/zsh`,
        ORCA_SHELL_READY_MARKER: options.emitReadyMarker ? '1' : '0',
        ORCA_SHELL_STARTUP_IDENTITY: options.emitReadyMarker ? '1' : '0'
      },
      supportsReadyMarker: options.emitReadyMarker
    }
  }

  if (shellName === 'bash') {
    ensureShellReadyWrappers()
    return {
      args: ['--rcfile', `${getShellReadyWrapperRoot()}/bash/rcfile`],
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

  // Why: mirrors daemon/shell-ready.ts; markerless fish stays unwrapped.
  if (shellName === 'fish' && options.emitReadyMarker) {
    return {
      args: [
        '-l',
        '-C',
        `${getFishShellReadyInitCommand(SHELL_READY_MARKER_ESCAPED)}\n${getFishCodexShellLaunchPreflight()}`
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

export function getShellReadyLaunchConfig(shellPath: string): ShellReadyLaunchConfig {
  return getWrappedShellLaunchConfig(shellPath, { emitReadyMarker: true })
}

export function getMarkerlessShellLaunchConfig(shellPath: string): ShellReadyLaunchConfig {
  return getWrappedShellLaunchConfig(shellPath, { emitReadyMarker: false })
}
