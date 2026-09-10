import { addWslEnvKeys } from '../wsl-env'

/**
 * glab's `--hostname` rejects host:port, so a ported self-hosted GitLab must use the GITLAB_HOST env var instead — translate it.
 *
 * Lives outside runner.ts so lightweight callers (preflight probes) can route a
 * ported host without importing the heavy runner module.
 */
export function redirectPortedHostnameToEnv<T extends object>(
  args: string[],
  options: T
): { args: string[]; options: T & { env?: NodeJS.ProcessEnv } } {
  const i = args.indexOf('--hostname')
  if (i === -1 || i + 1 >= args.length) {
    return { args, options }
  }
  const host = args[i + 1]
  if (!/^[^/\s]+:\d+$/.test(host)) {
    return { args, options }
  }
  const env: NodeJS.ProcessEnv = {
    ...((options as { env?: NodeJS.ProcessEnv }).env ?? process.env),
    GITLAB_HOST: host
  }
  if (process.platform === 'win32') {
    // Why: spawn env stops at the wsl.exe boundary, so WSL glab loses the host:port binding unless WSLENV names GITLAB_HOST.
    addWslEnvKeys(env, ['GITLAB_HOST'])
  }
  return {
    args: [...args.slice(0, i), ...args.slice(i + 2)],
    options: { ...options, env }
  }
}
