// Wrappers consume the feature env before user config so children cannot inherit the selection.

export const SHELL_STARTUP_FEATURE_ENV = 'ORCA_SHELL_FEATURES'

export const SHELL_STARTUP_FEATURES = [
  'overlay',
  'history',
  'markers',
  'ready',
  'identity',
  'startup'
] as const

export type ShellStartupFeature = (typeof SHELL_STARTUP_FEATURES)[number]

const OVERLAY_ENV_KEYS = [
  'ORCA_DATA_ACCOUNT_DATA_HOME',
  'ORCA_OPENCODE_CONFIG_DIR',
  'ORCA_MIMOCODE_CONFIG_DIR',
  'ORCA_OMP_STATUS_EXTENSION',
  'ORCA_CODEX_HOME',
  'ORCA_AGENT_TEAMS_SHIM_DIR',
  'ORCA_REMOTE_CLI_BIN_DIR'
] as const

export type ShellStartupFeatureInput = {
  shellPath: string
  /** Use the spawn environment, never process.env. */
  env: Record<string, string | undefined>
  hasStartupCommand: boolean
  /** Delivery waits for the wrapper's OSC 777 marker. */
  waitsForShellReady: boolean
  emitsStartupIdentity: boolean
}

function shellName(shellPath: string): string {
  return shellPath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
}

// Ignore inherited feature selections; derive this launch from its own intent.
export function selectShellStartupFeatures(input: ShellStartupFeatureInput): ShellStartupFeature[] {
  const overlay = OVERLAY_ENV_KEYS.some((key) => Boolean(input.env[key]))
  const wrappedBefore = overlay || input.hasStartupCommand
  const ready = input.waitsForShellReady
  // System zshrc overwrites HISTFILE; bash needs no wrapper for history alone.
  const history =
    shellName(input.shellPath) === 'zsh' && (Boolean(input.env.ORCA_HISTFILE) || wrappedBefore)

  const features: ShellStartupFeature[] = []
  if (overlay) {
    features.push('overlay')
  }
  if (history) {
    features.push('history')
  }
  // History-only panes must not gain command-marker output.
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
