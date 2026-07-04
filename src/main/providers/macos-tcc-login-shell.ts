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
 * Wrap a macOS shell spawn in `/usr/bin/login -flpq <user> …` so terminal children
 * get their own TCC identity instead of collapsing into Orca's bundle id — signed
 * CLIs like `op` otherwise re-prompt every launch because tccd attributes the grant
 * to Orca and never persists it (#6996). This mirrors how Terminal.app spawns shells.
 *
 * Why the env(1) interposition: login(1) overwrites SHELL from the account DB even
 * under -p, so `/usr/bin/env SHELL=<shell>` re-asserts the shell Orca actually runs
 * without disturbing login's attribution (skipped when the shell path contains `=`).
 *
 * No-op off macOS, when already wrapped, or when disabled via {@link DISABLE_ENV_VAR}.
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
