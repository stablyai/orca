// Use the real selector so test feature sets follow production.
import { selectShellStartupFeatures } from './shell-startup-features'

export const STARTUP_COMMAND_FEATURES = selectShellStartupFeatures({
  shellPath: 'zsh',
  env: {},
  hasStartupCommand: true,
  waitsForShellReady: true,
  emitsStartupIdentity: true
})

export const OVERLAY_ONLY_FEATURES = selectShellStartupFeatures({
  shellPath: 'zsh',
  env: { ORCA_CODEX_HOME: '/tmp/orca-codex-home' },
  hasStartupCommand: false,
  waitsForShellReady: false,
  emitsStartupIdentity: false
})
