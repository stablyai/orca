import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'

const MACOS_LOGIN_PATH = '/usr/bin/login'
const MACOS_ENV_PATH = '/usr/bin/env'

/**
 * Env escape hatch to force the plain (unwrapped) spawn. Set to `1`/`true` if a
 * user's environment misbehaves under login(1); terminals fall back to today's
 * direct-spawn behavior.
 */
const DISABLE_ENV_VAR = 'ORCA_DISABLE_MACOS_LOGIN_SHELL'

function isDisabledByEnv(): boolean {
  const value = process.env[DISABLE_ENV_VAR]
  return value === '1' || value === 'true'
}

/**
 * Wrap a macOS POSIX shell spawn in `/usr/bin/login` so terminal children carry
 * their own TCC identity instead of collapsing into Orca's bundle identifier.
 *
 * Why: when Orca spawns a shell directly, macOS attributes a spawned CLI's
 * "access other apps' data" request (kTCCServiceSystemPolicyAppData) to Orca's
 * bundle id and never persists the grant, so signed CLIs like `op` re-prompt on
 * every launch (#6996). Native terminals (Terminal.app and others) launch shells
 * through login(1), which lets tccd resolve each child's own code identity and
 * remember the decision. This matches that spawn shape without a native patch.
 *
 * Flags: -f (skip auth; we are the logged-in user relaunching as ourselves),
 * -l (do not chdir to home — node-pty already set cwd — and skip the login
 * dash-argv0 marker), -p (preserve Orca's env, including its ZDOTDIR shell
 * integration), -q (suppress the login banner so wrapped terminals look
 * unchanged). The underlying shell keeps its own args (e.g. zsh's `-l`) so
 * login-shell behavior is unchanged.
 *
 * SHELL: even under -p, login(1) overwrites SHELL with the account shell from
 * the user database, while Orca terminals deliberately export the shell they
 * actually run (fallback shells, custom shell settings). Interposing
 * `/usr/bin/env SHELL=<shell>` between login and the shell re-asserts the
 * intended value — and, as a same-process exec, does not disturb login's TCC
 * attribution. Skipped only if the shell path itself contains `=`, which env(1)
 * would misparse as an assignment.
 *
 * No-op off macOS, when already wrapped, when the login binary or username is
 * unavailable, or when disabled via {@link DISABLE_ENV_VAR}, so terminal
 * spawning never regresses.
 */
export function wrapShellSpawnForMacosTccAttribution(
  file: string,
  args: string[],
  env?: Record<string, string | undefined>
): { file: string; args: string[] } {
  if (process.platform !== 'darwin') {
    return { file, args }
  }
  if (file === MACOS_LOGIN_PATH || isDisabledByEnv()) {
    return { file, args }
  }
  if (!existsSync(MACOS_LOGIN_PATH)) {
    return { file, args }
  }

  let username: string
  try {
    username = userInfo().username
  } catch {
    return { file, args }
  }
  if (!username) {
    return { file, args }
  }

  const shellEnvValue = env?.SHELL || file
  const interposedShellEnv =
    !file.includes('=') && existsSync(MACOS_ENV_PATH)
      ? [MACOS_ENV_PATH, `SHELL=${shellEnvValue}`]
      : []

  return {
    file: MACOS_LOGIN_PATH,
    args: ['-flpq', username, ...interposedShellEnv, file, ...args]
  }
}
