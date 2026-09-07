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
import { POSIX_SHELL_STARTUP_COMMAND_ENV } from '../pty/posix-shell-startup-command'
import { getFishShellReadyInitCommand } from '../shell-templates'
import {
  encodeShellStartupFeatures,
  SHELL_STARTUP_FEATURE_ENV,
  type ShellStartupFeature
} from '../shell-startup-features'
import { inheritedZdotdirEnv, resolveInheritedZdotdir } from '../zsh-wrapper-dir-ownership'
import { ensureShellReadyWrappers } from './local-pty-shell-ready-wrapper-generation'
import {
  getShellReadyWrapperRoot,
  shellReadyWrappersExist,
  SHELL_READY_MARKER_ESCAPED
} from './local-pty-shell-ready-wrapper-root'
export {
  createShellReadyScanState,
  drainShellReadyHeldBytes,
  scanForShellReady,
  SHELL_READY_MARKER_PREFIX
} from '../shell-ready-marker-scanner'
export type { ShellReadyScanResult, ShellReadyScanState } from '../shell-ready-marker-scanner'

export type ShellReadyLaunchConfig = {
  args: string[] | null
  env: Record<string, string>
  supportsReadyMarker: boolean
}

const UNWRAPPED: ShellReadyLaunchConfig = {
  args: null,
  env: {},
  supportsReadyMarker: false
}

/** True when the wrapper tree is complete on disk right now. */
function wrapperTreeUsable(): boolean {
  const ensured = ensureShellReadyWrappers()
  return ensured && shellReadyWrappersExist()
}

/** Args that point bash at Orca's rcfile, or null when it is not usable. */
export function getBashWrapperLaunchArgs(): string[] | null {
  return shellReadyWrappersExist()
    ? ['--rcfile', `${getShellReadyWrapperRoot()}/bash/rcfile`]
    : null
}

/**
 * The one launch-config entry point: args + env for a shell that should start
 * with exactly `features` enabled. An empty selection is never wrapped.
 */
export function getShellLaunchConfig(
  shellPath: string,
  features: readonly ShellStartupFeature[],
  startupCommand?: string
): ShellReadyLaunchConfig {
  const shellName = pathWin32.basename(basename(shellPath)).toLowerCase()
  const wrapperFeatures =
    startupCommand !== undefined && !features.includes('startup')
      ? [...features, 'startup' as const]
      : features

  if (shellName === 'zsh') {
    if (wrapperFeatures.length === 0) {
      return UNWRAPPED
    }
    if (!wrapperTreeUsable()) {
      // Why plain login zsh: ZDOTDIR pointed at an incomplete wrapper dir makes
      // zsh skip the user's whole config. Losing Orca's features is recoverable.
      return { args: ['-l'], env: {}, supportsReadyMarker: false }
    }
    return {
      args: ['-l'],
      env: {
        ...inheritedZdotdirEnv(resolveInheritedZdotdir(process.env)),
        ZDOTDIR: `${getShellReadyWrapperRoot()}/zsh`,
        [SHELL_STARTUP_FEATURE_ENV]: encodeShellStartupFeatures(wrapperFeatures),
        ...(startupCommand !== undefined
          ? { [POSIX_SHELL_STARTUP_COMMAND_ENV]: startupCommand }
          : {})
      },
      supportsReadyMarker: features.includes('ready')
    }
  }

  if (shellName === 'bash') {
    if (features.length === 0) {
      return UNWRAPPED
    }
    ensureShellReadyWrappers()
    const args = getBashWrapperLaunchArgs()
    if (!args) {
      return UNWRAPPED
    }
    return {
      args,
      env: {
        [SHELL_STARTUP_FEATURE_ENV]: encodeShellStartupFeatures(wrapperFeatures),
        ...(startupCommand !== undefined
          ? { [POSIX_SHELL_STARTUP_COMMAND_ENV]: startupCommand }
          : {})
      },
      supportsReadyMarker: features.includes('ready')
    }
  }

  if (isPowerShellExecutableName(shellName)) {
    return {
      args: [
        '-NoLogo',
        '-NoExit',
        // Why base64 and not -Command: see powershell-osc133-bootstrap.ts (MDE review).
        '-EncodedCommand',
        encodePowerShellCommand(getPowerShellOsc133Bootstrap())
      ],
      env: {},
      supportsReadyMarker: false
    }
  }

  // Why: mirrors daemon/shell-ready.ts; markerless fish stays unwrapped. The
  // selection is baked into the init command, so fish needs no feature env var.
  if (shellName === 'fish' && (features.includes('ready') || startupCommand !== undefined)) {
    return {
      args: [
        '-l',
        '-C',
        `${getFishShellReadyInitCommand(
          SHELL_READY_MARKER_ESCAPED,
          features.includes('ready'),
          startupCommand !== undefined
        )}\n${getFishCodexShellLaunchPreflight()}`
      ],
      env:
        startupCommand !== undefined ? { [POSIX_SHELL_STARTUP_COMMAND_ENV]: startupCommand } : {},
      supportsReadyMarker: features.includes('ready')
    }
  }

  return UNWRAPPED
}
