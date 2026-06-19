import { readShellStartupEnvVar } from '../main/pty/shell-startup-env'
import type { PiAgentKind } from '../shared/pi-agent-kind'

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
  shell: string | undefined,
  kind: PiAgentKind
): string | undefined {
  const sourceKey = kind === 'omp' ? 'ORCA_OMP_SOURCE_AGENT_DIR' : 'ORCA_PI_SOURCE_AGENT_DIR'
  const overlayKey = kind === 'omp' ? 'ORCA_OMP_CODING_AGENT_DIR' : 'ORCA_PI_CODING_AGENT_DIR'
  const otherOverlayKey = kind === 'omp' ? 'ORCA_PI_CODING_AGENT_DIR' : 'ORCA_OMP_CODING_AGENT_DIR'

  const sourceDir = firstNonEmpty(env[sourceKey])
  if (sourceDir) {
    return sourceDir
  }

  const startupDir = readStartupEnv('PI_CODING_AGENT_DIR', env, shell)
  if (startupDir) {
    return startupDir
  }

  // Why: a mismatched Orca overlay shadow means this shell inherited the other
  // Pi-compatible agent's PTY overlay. Do not remirror that overlay into this
  // launch; let plugin-overlay default to the selected kind's own home dir.
  if (
    env.PI_CODING_AGENT_DIR &&
    env.PI_CODING_AGENT_DIR !== env[overlayKey] &&
    env.PI_CODING_AGENT_DIR !== env[otherOverlayKey]
  ) {
    return env.PI_CODING_AGENT_DIR
  }
  return undefined
}
