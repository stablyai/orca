/**
 * A WSL host's orcad is started by `wsl.exe --exec sh -c`, so no rc file ran and git, gh and glab
 * calls it makes miss what the user's shell exports (SSH agent, proxies, signing, forge tokens).
 * The bridge ran those calls in `$SHELL -ilc`; this restores that for an allowlist of variables.
 * Terminals need none of it: they are login shells and source the rc files themselves.
 */
import { isWslHostOrcadProcess } from '../ipc/wsl-guest-windows-drive-path'
import { PROBE_MARKER_ENV_VAR } from '../startup/hydrate-shell-path'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'

// Why an allowlist: the snapshot is the whole rc environment, and PATH has its own hydration with
// the Windows-drive rules; askpass helpers are left out because a GUI one would block a headless git.
export const WSL_HOST_LOGIN_ENV_NAMES: readonly string[] = [
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_SSH_VARIANT',
  'GIT_CONFIG_GLOBAL',
  'GNUPGHOME',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'GIT_SSL_CAINFO',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_HOST',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_CONFIG_DIR',
  'GITLAB_TOKEN',
  'GITLAB_ACCESS_TOKEN',
  'OAUTH_TOKEN',
  'GITLAB_HOST',
  'GL_HOST',
  'GLAB_CONFIG_DIR',
  'GLAB_PROXY',
  'GLAB_CA_CERT',
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR'
]

/** The allowlisted variables whose login-shell value differs from `current`. */
export function wslHostLoginEnvironmentOverlay(
  shellEnv: NodeJS.ProcessEnv,
  current: NodeJS.ProcessEnv
): Record<string, string> {
  const overlay: Record<string, string> = {}
  for (const name of WSL_HOST_LOGIN_ENV_NAMES) {
    const value = shellEnv[name]
    if (value !== undefined && value !== current[name]) {
      overlay[name] = value
    }
  }
  return overlay
}

/**
 * Lays the login shell's allowlisted variables over this process's env, before the terminal daemon
 * and the first git call inherit it. A no-op off a WSL host; a failed probe keeps the launch env.
 */
export async function adoptWslHostLoginEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  // The PATH probe's marker and budget: an rc that skips `exec tmux` for it skips it here too,
  // and a profile measured at 6-7 s under load still lands.
  resolveShellEnv: () => Promise<NodeJS.ProcessEnv> = () =>
    resolveLoginShellEnvironment({
      env: { ...env, [PROBE_MARKER_ENV_VAR]: '1' },
      timeoutMs: 10_000
    }),
  isWslHost: () => boolean = () => isWslHostOrcadProcess(env)
): Promise<string[]> {
  if (!isWslHost()) {
    return []
  }
  const overlay = wslHostLoginEnvironmentOverlay(await resolveShellEnv(), env)
  Object.assign(env, overlay)
  return Object.keys(overlay)
}
