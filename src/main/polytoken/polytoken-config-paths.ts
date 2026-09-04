import { homedir } from 'node:os'
import { join, posix as pathPosix } from 'node:path'

// Why: Polytoken reads its global hooks from `$XDG_CONFIG_HOME/polytoken/hooks.json`
// (default `~/.config/polytoken/hooks.json`) on every host it supports (macOS/Linux/WSL).
// The XDG spec requires an absolute value; a relative one is treated as unset so a hooks
// write can never land relative to Orca's working directory.
export function resolvePolytokenConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim()
  return xdgConfigHome && pathPosix.isAbsolute(xdgConfigHome)
    ? join(xdgConfigHome, 'polytoken')
    : join(home, '.config', 'polytoken')
}

export function resolvePolytokenHooksJsonPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  return join(resolvePolytokenConfigDir(env, home), 'hooks.json')
}

// Why: remote installs only know the login home; the relay does not read the remote
// shell's XDG_CONFIG_HOME, so the documented default location is used.
export function resolveRemotePolytokenHooksJsonPath(remoteHome: string): string {
  return pathPosix.join(remoteHome, '.config', 'polytoken', 'hooks.json')
}
