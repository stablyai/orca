/**
 * The single env variable MCode uses to tell a launched shell which startup
 * features its wrapper should turn on, plus the pure selection that fills it.
 *
 * Why a positive allowlist the wrapper destroys before anything else runs:
 * every earlier switch was a negative, exported one (`MCODE_SHELL_READY_MARKER=0`,
 * `MCODE_SHELL_COMMAND_MARKERS=0`). Those live in the pane's PTY env, so every
 * child inherits them — a pane launched with a feature suppressed suppressed it
 * for an MCode started from that pane too. With an allowlist, an inherited or
 * stale value can only ever mean *fewer* features, never more, and the wrapper
 * unsets it before the user's own config (or anything it spawns) can see it.
 */

export const SHELL_STARTUP_FEATURE_ENV = 'MCODE_SHELL_FEATURES'

export const SHELL_STARTUP_FEATURES = [
  'overlay',
  'history',
  'markers',
  'ready',
  'identity'
] as const

export type ShellStartupFeature = (typeof SHELL_STARTUP_FEATURES)[number]

/** Spawn-env keys that mean this pane carries an MCode overlay the wrapper must re-apply. */
const OVERLAY_ENV_KEYS = [
  'MCODE_OPENCODE_CONFIG_DIR',
  'MCODE_MIMOCODE_HOME',
  'MCODE_OMP_STATUS_EXTENSION',
  'MCODE_CODEX_HOME',
  'MCODE_AGENT_TEAMS_SHIM_DIR',
  'MCODE_REMOTE_CLI_BIN_DIR'
] as const

export type ShellStartupFeatureInput = {
  /** Path (or bare name) of the shell being launched. */
  shellPath: string
  /** The env this spawn will hand the shell — never `process.env`. */
  env: Record<string, string | undefined>
  /** True when MCode will deliver a startup command into this pane. */
  hasStartupCommand: boolean
  /** True when that delivery waits for the wrapper's OSC 777 readiness marker. */
  waitsForShellReady: boolean
  /** True when MCode needs the shell to announce its PID at startup. */
  emitsStartupIdentity: boolean
}

function shellName(shellPath: string): string {
  return shellPath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
}

/**
 * Pure function of spawn env + launch intent. Nothing here reads
 * `MCODE_SHELL_FEATURES`, so a value inherited from a parent shell cannot
 * enable or disable anything for the shell MCode is about to launch.
 */
export function selectShellStartupFeatures(input: ShellStartupFeatureInput): ShellStartupFeature[] {
  const overlay = OVERLAY_ENV_KEYS.some((key) => Boolean(input.env[key]))
  // Exactly the panes MCode wrapped before history widened wrapping.
  const wrappedBefore = overlay || input.hasStartupCommand
  const ready = input.waitsForShellReady
  // Why zsh only: the unguarded HISTFILE assignment lives in the *system zshrc*.
  // bash has no equivalent, and wrapping bash for history alone would swap its
  // login startup-file chain for MCode's approximation of one.
  // Why also when MCode injected nothing: any wrapped pane has MCode's ZDOTDIR in
  // place while the system zshrc runs, so the clobbered value it derives lands
  // inside MCode's wrapper dir and has to be repaired the same way.
  const history =
    shellName(input.shellPath) === 'zsh' && (Boolean(input.env.MCODE_HISTFILE) || wrappedBefore)

  const features: ShellStartupFeature[] = []
  if (overlay) {
    features.push('overlay')
  }
  if (history) {
    features.push('history')
  }
  // Why gated on wrappedBefore: a pane wrapped only for history must stay
  // observably identical to the unwrapped pane it was before this change.
  if (wrappedBefore) {
    features.push('markers')
  }
  if (ready) {
    features.push('ready')
  }
  if (input.emitsStartupIdentity) {
    features.push('identity')
  }
  return features
}

export function encodeShellStartupFeatures(features: readonly ShellStartupFeature[]): string {
  return features.join(',')
}
