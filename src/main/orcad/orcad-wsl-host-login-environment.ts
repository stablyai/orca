// WSL exec skips shell setup; hydrate login-shell credentials/proxies before git and daemon startup.
import { isWslHostOrcadProcess } from '../ipc/wsl-guest-windows-drive-path'
import { PROBE_MARKER_ENV_VAR } from '../startup/hydrate-shell-path'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'

// Allowlist excludes GUI askpass (which could block) and PATH (which has separate drive filtering).
const WSL_HOST_LOGIN_ENV_NAMES: readonly string[] = [
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

/** Failed login probes retain the launch environment; non-WSL hosts remain unchanged. */
export async function adoptWslHostLoginEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  // Reuse PATH probe markers to suppress interactive rc behavior within its startup budget.
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
