import type { WorkerAuthorityIsolationLaunchRequest } from '../../shared/worker-authority-policy'

const HOST_DOCKER_ENV = new Set([
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_HOST',
  'HOME',
  'LANG',
  'LC_ALL',
  'PATH',
  'TERM'
])

export function workerAuthorityMount(
  source: string,
  destination: string,
  mode: 'ro' | 'rw'
): string {
  if (source.includes(',') || destination.includes(',')) {
    throw new Error('worker_authority_isolation_failed')
  }
  return `type=bind,src=${source},dst=${destination}${mode === 'ro' ? ',readonly' : ''}`
}

export function buildWorkerAuthorityHostEnvironment(
  source: Record<string, string>
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (HOST_DOCKER_ENV.has(key) && value) {
      env[key] = value
    }
  }
  return env
}

export function buildWorkerAuthorityContainerEnvironment(
  request: WorkerAuthorityIsolationLaunchRequest
): string[] {
  const values = {
    HOME: '/home/orca-worker',
    CODEX_HOME: '/home/orca-worker/.codex',
    XDG_CONFIG_HOME: '/home/orca-worker/.config',
    XDG_CACHE_HOME: '/home/orca-worker/.cache',
    GH_CONFIG_DIR: '/home/orca-worker/.config/gh',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    SSH_AUTH_SOCK: '',
    ORCA_DISPATCH_ID: request.dispatchId,
    ORCA_LIFECYCLE_BINDING: request.lifecycleBinding,
    ORCA_LIFECYCLE_DIR: '/orca-control',
    TERM: 'xterm-256color'
  }
  return Object.entries(values).flatMap(([key, value]) => ['--env', `${key}=${value}`])
}
