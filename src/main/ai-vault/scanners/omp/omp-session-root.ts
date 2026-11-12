import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, normalize, parse, resolve, win32 } from 'node:path'
import { normalizeAgentSessionsDir } from '../../session-scanner-values'
import { normalizedOmpProfile } from '../../../../shared/omp-profile'

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
  const profile = normalizedOmpProfile(
    env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE
  )
  if (profile === null) {
    return ''
  }
  const baseConfig = join(home, env.PI_CONFIG_DIR || '.omp')
  const configRoot = profile ? join(baseConfig, 'profiles', profile) : baseConfig
  const defaultAgent = join(configRoot, 'agent')
  const inheritedProfile = normalizedOmpProfile(env.PI_PROFILE)
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

/** Existing session dirs of named profiles: each OMP run picks its profile from its own env, not Orca's. */
export function ompProfileSessionsDirs(
  options: {
    env?: NodeJS.ProcessEnv
    homeDir?: string
    platform?: NodeJS.Platform
  } = {}
): string[] {
  const env = options.env ?? process.env
  const home = options.homeDir ?? homedir()
  const platform = options.platform ?? process.platform
  // The legacy override pins one location; enumeration would widen it.
  if (env.OMP_CODING_AGENT_DIR?.trim()) {
    return []
  }
  const profilesDir = join(home, env.PI_CONFIG_DIR || '.omp', 'profiles')
  const xdgProfilesDir =
    (platform === 'linux' || platform === 'darwin') && env.XDG_DATA_HOME
      ? join(env.XDG_DATA_HOME, 'omp', 'profiles')
      : undefined
  const names = new Set(
    [profilesDir, xdgProfilesDir].flatMap((dir) => (dir ? profileDirNames(dir) : []))
  )
  return [...names]
    .sort()
    .flatMap((name) => [
      // OMP writes here once the profile's XDG dir exists, so ID lookup must find it before older copies.
      ...(xdgProfilesDir ? [join(xdgProfilesDir, name, 'sessions')] : []),
      join(profilesDir, name, 'agent', 'sessions')
    ])
    .filter((dir) => existsSync(dir))
}

function profileDirNames(profilesDir: string): string[] {
  try {
    return readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && normalizedOmpProfile(entry.name) === entry.name)
      .map((entry) => entry.name)
  } catch {
    return []
  }
}
