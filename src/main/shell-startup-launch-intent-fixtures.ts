/**
 * The two launch intents MCode's call sites choose between, resolved through the
 * real selector so tests cannot drift from the decision production makes.
 *
 * Test support only; nothing under src/main imports this at runtime.
 */
import { selectShellStartupFeatures } from './shell-startup-features'

/** A pane MCode will write a startup command into. */
export const STARTUP_COMMAND_FEATURES = selectShellStartupFeatures({
  shellPath: 'zsh',
  env: {},
  hasStartupCommand: true,
  waitsForShellReady: true,
  emitsStartupIdentity: true
})

/** A pane carrying an MCode overlay but no startup command. */
export const OVERLAY_ONLY_FEATURES = selectShellStartupFeatures({
  shellPath: 'zsh',
  env: { MCODE_CODEX_HOME: '/tmp/mcode-codex-home' },
  hasStartupCommand: false,
  waitsForShellReady: false,
  emitsStartupIdentity: false
})
