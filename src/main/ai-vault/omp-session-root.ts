import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, normalize, parse, resolve, win32 } from 'node:path'
import { normalizeAgentSessionsDir } from './session-scanner-values'

function normalizedProfile(value: string | undefined): string | undefined | null {
  const profile = value?.trim()
  if (!profile || profile === 'default') {
    return undefined
  }
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile) &&
    !profile.endsWith('.') &&
    !/^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i.test(profile)
    ? profile
    : null
}

function safeRoot(value: string): string {
  const trimmed = value.trim()
  const normalized = normalize(trimmed)
  return !trimmed ||
    normalized === '.' ||
    normalized === parse(normalized).root ||
    normalized === win32.parse(normalized).root ||
    /^[a-z]:(?:\.)?$/i.test(normalized)
    ? ''
    : trimmed
}

/** Mirrors OMP dirs.ts on the execution host; an explicit root never falls back. */
export function resolveOmpSessionsDir(
  options: {
    sessionsDir?: string
    env?: NodeJS.ProcessEnv
    homeDir?: string
    platform?: NodeJS.Platform
  } = {}
): string {
  if (options.sessionsDir !== undefined) {
    return safeRoot(options.sessionsDir)
  }
  const env = options.env ?? process.env
  const home = options.homeDir ?? homedir()
  const platform = options.platform ?? process.platform
  // Orca's legacy override accepts a sessions root, agent root, or .omp root.
  if (env.OMP_CODING_AGENT_DIR?.trim()) {
    return safeRoot(normalizeAgentSessionsDir(env.OMP_CODING_AGENT_DIR, '.omp'))
  }
  const profile = normalizedProfile(
    env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE
  )
  if (profile === null) {
    return ''
  }
  const baseConfig = join(home, env.PI_CONFIG_DIR || '.omp')
  const configRoot = profile ? join(baseConfig, 'profiles', profile) : baseConfig
  const defaultAgent = join(configRoot, 'agent')
  const inheritedProfile = normalizedProfile(env.PI_PROFILE)
  const inheritedAgent = inheritedProfile
    ? join(baseConfig, 'profiles', inheritedProfile, 'agent')
    : undefined
  const override =
    !profile && env.PI_CODING_AGENT_DIR !== inheritedAgent ? env.PI_CODING_AGENT_DIR : undefined
  const agentDir = override ? resolve(override) : defaultAgent
  if (!safeRoot(agentDir)) {
    return ''
  }
  if (
    (platform === 'linux' || platform === 'darwin') &&
    agentDir === defaultAgent &&
    env.XDG_DATA_HOME
  ) {
    const appRoot = join(env.XDG_DATA_HOME, 'omp')
    const dataRoot = profile ? join(appRoot, 'profiles', profile) : appRoot
    if (existsSync(dataRoot)) {
      return safeRoot(join(dataRoot, 'sessions'))
    }
  }
  return safeRoot(join(agentDir, 'sessions'))
}
