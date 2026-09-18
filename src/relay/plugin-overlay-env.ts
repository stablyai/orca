import { readSessionShellStartupEnvVar } from '../main/pty/shell-startup-env'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  PRIMARY_AGENT_DIR_ENV_BY_KIND,
  SOURCE_AGENT_DIR_ENV_BY_KIND,
  type PiAgentKind
} from '../shared/pi-agent-kind'

export type PiSourceAgentDirResolution = {
  path: string
  origin: 'explicit-profile' | 'source-override' | 'startup-env' | 'launch-default'
  createIfMissing: boolean
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  return values.find((value) => typeof value === 'string' && value.length > 0)
}

function readStartupEnv(
  name: string,
  env: Record<string, string>,
  shell: string | undefined
): string | undefined {
  // Why the session env first: it is closer to the user's shell than the relay
  // process env, and fish config lives under its XDG_CONFIG_HOME.
  return readSessionShellStartupEnvVar(name, env, shell)
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
  kind: PiAgentKind,
  launchCommand?: string
): PiSourceAgentDirResolution | undefined {
  const sourceKey = SOURCE_AGENT_DIR_ENV_BY_KIND[kind]
  const primaryKey = PRIMARY_AGENT_DIR_ENV_BY_KIND[kind]
  const overlayKey = kind === 'omp' ? 'ORCA_OMP_CODING_AGENT_DIR' : 'ORCA_PI_CODING_AGENT_DIR'
  const otherOverlayKey = kind === 'omp' ? 'ORCA_PI_CODING_AGENT_DIR' : 'ORCA_OMP_CODING_AGENT_DIR'

  const ompProfile =
    kind === 'omp'
      ? [readOmpProfileFromCommand(launchCommand), env.OMP_PROFILE, env.PI_PROFILE].find(
          (candidate) => candidate !== undefined && isSafeOmpProfile(candidate)
        )
      : undefined

  // OMP's `default` profile is the base config root and honors an explicit
  // PI_CODING_AGENT_DIR; only named profiles use the nested profile tree.
  if (kind === 'omp' && ompProfile && ompProfile !== 'default') {
    const configuredRoot = firstNonEmpty(
      env.PI_CONFIG_DIR,
      readStartupEnv('PI_CONFIG_DIR', env, shell)
    )
    const configDir = configuredRoot ?? join(env.HOME ?? process.env.HOME ?? homedir(), '.omp')
    return {
      path: join(configDir, 'profiles', ompProfile, 'agent'),
      origin: 'explicit-profile',
      createIfMissing: true
    }
  }

  if (kind === 'omp' && ompProfile === 'default') {
    const explicitDir = firstNonEmpty(env[primaryKey])
    const ownOverlayDir = firstNonEmpty(env[overlayKey])
    const otherOverlayDir = firstNonEmpty(env[otherOverlayKey])
    if (explicitDir && explicitDir !== ownOverlayDir && explicitDir !== otherOverlayDir) {
      return { path: explicitDir, origin: 'source-override', createIfMissing: false }
    }
  }

  const sourceDir = firstNonEmpty(env[sourceKey])
  if (sourceDir) {
    return { path: sourceDir, origin: 'source-override', createIfMissing: false }
  }

  const startupDir = readStartupEnv(primaryKey, env, shell)
  if (startupDir) {
    return { path: startupDir, origin: 'startup-env', createIfMissing: false }
  }

  if (kind === 'prime-agent') {
    const primeDir = firstNonEmpty(env[primaryKey])
    return primeDir
      ? { path: primeDir, origin: 'source-override', createIfMissing: false }
      : undefined
  }

  // Why: a mismatched Orca overlay shadow means this shell inherited the other
  // Pi-compatible agent's PTY overlay. Do not remirror that overlay into this
  // launch; let plugin-overlay default to the selected kind's own home dir.
  if (
    env[primaryKey] &&
    env[primaryKey] !== env[overlayKey] &&
    env[primaryKey] !== env[otherOverlayKey]
  ) {
    return {
      path: env[primaryKey],
      origin: 'source-override',
      createIfMissing: false
    }
  }

  // OMP resolves its agent directory from PI_CONFIG_DIR before it populates
  // PI_CODING_AGENT_DIR. Resolve the launch profile up front so the relay
  // materializes the extension where the remote OMP process will load it.
  if (kind === 'omp') {
    const configuredRoot = firstNonEmpty(
      env.PI_CONFIG_DIR,
      readStartupEnv('PI_CONFIG_DIR', env, shell)
    )
    if (configuredRoot) {
      return {
        path: join(configuredRoot, 'agent'),
        origin: 'explicit-profile',
        createIfMissing: true
      }
    }
    if (launchCommand?.trim()) {
      return {
        path: join(env.HOME ?? process.env.HOME ?? homedir(), '.omp', 'agent'),
        origin: 'launch-default',
        createIfMissing: true
      }
    }
  }
  return undefined
}

function readOmpProfileFromCommand(command: string | undefined): string | undefined {
  const match = command?.match(/(?:^|\s)--profile(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/)
  const profile = match?.[1] ?? match?.[2] ?? match?.[3]
  return profile && isSafeOmpProfile(profile) ? profile : undefined
}

function isSafeOmpProfile(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
}

/** Carry shell-selected XDG roots into relay-spawned daemon children. */
export function inheritOmpXdgEnvironment(
  env: Record<string, string>,
  shell: string | undefined
): Record<string, string> {
  const next: Record<string, string> = {}
  for (const name of ['XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'] as const) {
    if (env[name] !== undefined) {
      continue
    }
    const value = readStartupEnv(name, env, shell) ?? process.env[name]
    if (value) {
      next[name] = value
    }
  }
  return next
}
