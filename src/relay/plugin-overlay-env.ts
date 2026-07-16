import { readShellStartupEnvVar } from '../main/pty/shell-startup-env'
import { getCommandTokenPathBasename, getFirstCommandToken } from '../shared/command-token-scanner'
import type { PiAgentKind } from '../shared/pi-agent-kind'
import { resolveSetupAgentSequenceLaunchCommand } from '../shared/setup-agent-sequencing'
import type { PluginOverlayManager } from './plugin-overlay'

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

export function resolveMimoSourceHome(
  env: Record<string, string>,
  shell: string | undefined
): string | undefined {
  const sourceHome = firstNonEmpty(env.ORCA_MIMOCODE_SOURCE_HOME)
  if (sourceHome) {
    return sourceHome
  }
  const home = firstNonEmpty(readStartupEnv('MIMOCODE_HOME', env, shell), env.MIMOCODE_HOME)
  return home && home !== env.ORCA_MIMOCODE_HOME ? home : undefined
}

function isMimoLaunchCommand(command: string | undefined): boolean {
  const binary = getCommandTokenPathBasename(getFirstCommandToken(command ?? ''))
    .toLowerCase()
    .replace(/\.(?:cmd|exe|sh)$/, '')
  return binary === 'mimo'
}

export function buildMimoCodePluginOverlayEnv(
  pluginOverlay: Pick<PluginOverlayManager, 'hasMimoSource' | 'materializeMimo'>,
  ctx: {
    id: string
    paneKey?: string
    shell: string
    env: Record<string, string>
    command?: string
  }
): Record<string, string> {
  const launchCommand = resolveSetupAgentSequenceLaunchCommand(ctx.env, ctx.command)
  if (!pluginOverlay.hasMimoSource() || !isMimoLaunchCommand(launchCommand)) {
    return {}
  }
  const sourceHome = resolveMimoSourceHome(ctx.env, ctx.shell)
  const home = pluginOverlay.materializeMimo(ctx.paneKey ?? ctx.id, sourceHome)
  if (!home) {
    return {}
  }
  return {
    MIMOCODE_HOME: home,
    ORCA_MIMOCODE_HOME: home,
    ...(sourceHome ? { ORCA_MIMOCODE_SOURCE_HOME: sourceHome } : {})
  }
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
