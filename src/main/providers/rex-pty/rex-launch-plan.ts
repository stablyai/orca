import type { PtySpawnOptions } from '../pty/provider-contract'
import {
  createDaemonPtyEnvironment,
  finalizeDaemonPtyEnvironment
} from '../../daemon/pty-subprocess/spawn-environment'
import { getShellLaunchConfig } from '../local-pty/local-pty-shell-ready'
import { injectHistoryEnv, resolveShellKind } from '../../pty/history/terminal-history'
import {
  selectShellStartupFeatures,
  SHELL_STARTUP_FEATURE_ENV
} from '../../pty/shell-startup/shell-startup-features'
import { POSIX_SHELL_STARTUP_COMMAND_ENV } from '../../pty/shell-startup/posix-shell-startup-command'
import { seedPowerlevel10kWizardEnv } from '../../pty/shell-startup/powerlevel10k-wizard-env'
import { isRexLaunchEnvName } from './rex-launch-gate'
import { resolveRexLaunchShell } from './rex-shell-profiles'

/** Reuse Orca's existing environment scrubbing and per-worktree history policy.
 * The server's own capabilities are retained by the private launch gate, not supplied by Orca.
 * Provider-delivered commands intentionally retain their existing noninteractive semantics.
 */
export function createRexLaunchPlan(
  opts: PtySpawnOptions,
  cwd: string
): { argv: string[]; env: Record<string, string> } {
  const shell = resolveRexLaunchShell(opts.shellOverride)
  for (const key of [...Object.keys(opts.env ?? {}), ...(opts.envToDelete ?? [])]) {
    if (!isRexLaunchEnvName(key)) {
      throw new Error('Unsupported Rex launch environment key')
    }
  }
  const env = createDaemonPtyEnvironment({ ...opts, sessionId: opts.sessionId ?? 'rex-launch' })
  // Discard ambient server capabilities and shell controls inherited by Orca itself.
  for (const key of Object.keys(env)) {
    if (!isRexLaunchEnvName(key)) {
      delete env[key]
    }
  }
  delete env[SHELL_STARTUP_FEATURE_ENV]
  delete env[POSIX_SHELL_STARTUP_COMMAND_ENV]
  if (opts.historyIsolationEnabled && opts.worktreeId) {
    const history = injectHistoryEnv(env, opts.worktreeId, shell, cwd)
    if (
      ['bash', 'zsh', 'fish'].includes(history.shell) &&
      !history.histFile &&
      !history.fishSession &&
      !env.HISTFILE &&
      !env.fish_history
    ) {
      throw new Error('Rex scoped history could not be prepared')
    }
  }
  seedPowerlevel10kWizardEnv(env, { envToDelete: opts.envToDelete })
  const features = selectShellStartupFeatures({
    shellPath: shell,
    env,
    hasStartupCommand: false,
    waitsForShellReady: false,
    emitsStartupIdentity: false
  })
  if (opts.terminalShellArgs && features.length) {
    throw new Error('Rex shell arguments conflict with required startup wrappers')
  }
  const launch = getShellLaunchConfig(shell, features, undefined, {
    inheritedXdgDataDirs: env.XDG_DATA_DIRS,
    shellArgs: opts.terminalShellArgs
  })
  if (
    features.length &&
    resolveShellKind(shell) === 'zsh' &&
    !launch.env[SHELL_STARTUP_FEATURE_ENV]
  ) {
    throw new Error('Rex zsh startup wrapper unavailable')
  }
  Object.assign(env, launch.env)
  const args = opts.terminalShellArgs ?? launch.args ?? ['-il']
  finalizeDaemonPtyEnvironment(env, opts.env, opts.envToDelete)
  if (opts.env?.COLORTERM !== undefined) {
    env.COLORTERM = opts.env.COLORTERM
  }
  for (const key of opts.envToDelete ?? []) {
    delete env[key]
  }
  // Avoid supplying an inherited shell name that disagrees with the actual executable.
  if (!(opts.envToDelete ?? []).includes('SHELL')) {
    env.SHELL = shell
  }
  return { argv: [shell, ...args], env }
}
