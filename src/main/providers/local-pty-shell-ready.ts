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
import {
  getFishCommandMarkerInitCommand,
  shellCommandMarkerEnv
} from '../shell-command-marker-template'
import {
  isShellCommandMarkerInjectionEnabled,
  type ShellIntegrationHostClass
} from '../shell-integration-injection-policy'
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
  mode: 'wrapped' | 'unwrapped'
  args: string[] | null
  env: Record<string, string>
  supportsReadyMarker: boolean
  supportsCommandMarkers: boolean
  failureReason?:
    | 'host-class-disabled'
    | 'marker-injection-unavailable'
    | 'unsupported-shell'
    | 'wrapper-tree-unavailable'
    | 'fish-init-unavailable'
}

const UNWRAPPED: ShellReadyLaunchConfig = {
  mode: 'unwrapped',
  args: null,
  env: {},
  supportsReadyMarker: false,
  supportsCommandMarkers: false,
  failureReason: 'unsupported-shell'
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
  options: {
    commandNonce?: string
    hostClass?: ShellIntegrationHostClass
  } = {}
): ShellReadyLaunchConfig {
  const shellName = pathWin32.basename(basename(shellPath)).toLowerCase()
  const commandMarkersRequested = features.includes('markers')
  const commandMarkerPolicyEnabled =
    !options.hostClass || isShellCommandMarkerInjectionEnabled(options.hostClass)
  const commandMarkersEnabled =
    commandMarkersRequested && commandMarkerPolicyEnabled && Boolean(options.commandNonce)
  const effectiveFeatures = commandMarkersEnabled
    ? features
    : features.filter((feature) => feature !== 'markers')
  const markerEnv =
    commandMarkersEnabled && options.commandNonce ? shellCommandMarkerEnv(options.commandNonce) : {}

  if (commandMarkersRequested && effectiveFeatures.length === 0) {
    return {
      ...UNWRAPPED,
      failureReason: commandMarkerPolicyEnabled
        ? 'marker-injection-unavailable'
        : 'host-class-disabled'
    }
  }

  if (shellName === 'zsh') {
    if (effectiveFeatures.length === 0) {
      return UNWRAPPED
    }
    if (!wrapperTreeUsable()) {
      // Why plain login zsh: ZDOTDIR pointed at an incomplete wrapper dir makes
      // zsh skip the user's whole config. Losing Orca's features is recoverable.
      return {
        ...UNWRAPPED,
        args: ['-l'],
        failureReason: 'wrapper-tree-unavailable'
      }
    }
    return {
      mode: 'wrapped',
      args: ['-l'],
      env: {
        ...inheritedZdotdirEnv(resolveInheritedZdotdir(process.env)),
        ZDOTDIR: `${getShellReadyWrapperRoot()}/zsh`,
        [SHELL_STARTUP_FEATURE_ENV]: encodeShellStartupFeatures(effectiveFeatures),
        ...markerEnv
      },
      supportsReadyMarker: effectiveFeatures.includes('ready'),
      supportsCommandMarkers: commandMarkersEnabled
    }
  }

  if (shellName === 'bash') {
    if (effectiveFeatures.length === 0) {
      return UNWRAPPED
    }
    ensureShellReadyWrappers()
    const args = getBashWrapperLaunchArgs()
    if (!args) {
      return UNWRAPPED
    }
    return {
      mode: 'wrapped',
      args,
      env: {
        [SHELL_STARTUP_FEATURE_ENV]: encodeShellStartupFeatures(effectiveFeatures),
        ...markerEnv
      },
      supportsReadyMarker: effectiveFeatures.includes('ready'),
      supportsCommandMarkers: commandMarkersEnabled
    }
  }

  if (isPowerShellExecutableName(shellName)) {
    return {
      mode: 'wrapped',
      args: [
        '-NoLogo',
        '-NoExit',
        '-EncodedCommand',
        encodePowerShellCommand(getPowerShellOsc133Bootstrap())
      ],
      env: markerEnv,
      supportsReadyMarker: false,
      supportsCommandMarkers: commandMarkersEnabled
    }
  }

  // Why: mirrors daemon/shell-ready.ts; markerless fish stays unwrapped. The
  // selection is baked into the init command, so fish needs no feature env var.
  if (shellName === 'fish' && (effectiveFeatures.includes('ready') || commandMarkersEnabled)) {
    const initCommands = [
      commandMarkersEnabled ? getFishCommandMarkerInitCommand() : null,
      effectiveFeatures.includes('ready')
        ? `${getFishShellReadyInitCommand(SHELL_READY_MARKER_ESCAPED)}\n${getFishCodexShellLaunchPreflight()}`
        : null
    ].filter((command): command is string => command !== null)
    return {
      mode: 'wrapped',
      args: ['-l', '-C', initCommands.join('\n')],
      env: markerEnv,
      supportsReadyMarker: effectiveFeatures.includes('ready'),
      supportsCommandMarkers: commandMarkersEnabled
    }
  }

  return UNWRAPPED
}
