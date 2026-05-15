import { readShellStartupEnvVar } from '../main/pty/shell-startup-env'

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  return values.find((value) => typeof value === 'string' && value.length > 0)
}

function readStartupEnv(
  name: string,
  env: Record<string, string>,
  shell: string | undefined
): string | undefined {
  return readShellStartupEnvVar(name, env.HOME ?? process.env.HOME, shell ?? env.SHELL)
}

export function resolveOpenCodeSourceConfigDir(
  env: Record<string, string>,
  shell: string | undefined
): string | undefined {
  return firstNonEmpty(
    env.ORCA_OPENCODE_SOURCE_CONFIG_DIR,
    readStartupEnv('OPENCODE_CONFIG_DIR', env, shell),
    env.OPENCODE_CONFIG_DIR
  )
}

export function resolvePiSourceAgentDir(
  env: Record<string, string>,
  shell: string | undefined
): string | undefined {
  return firstNonEmpty(
    env.ORCA_PI_SOURCE_AGENT_DIR,
    readStartupEnv('PI_CODING_AGENT_DIR', env, shell),
    env.PI_CODING_AGENT_DIR
  )
}
