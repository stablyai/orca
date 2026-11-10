import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, normalize, parse, resolve, win32 } from 'node:path'
import { normalizeAgentSessionsDir } from '../../session-scanner-values'

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const RESERVED_PROFILE_NAME_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i

function isSafeProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name) && !name.endsWith('.') && !RESERVED_PROFILE_NAME_RE.test(name)
}

function normalizedProfile(value: string | undefined): string | undefined | null {
  const profile = value?.trim()
  if (!profile || profile === 'default') {
    return undefined
  }
  return isSafeProfileName(profile) ? profile : null
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

/**
 * Every existing profile session dir under the config home (and the XDG data
 * home on POSIX), so history from OMP_PROFILE/PI_PROFILE runs is discovered
 * even when this process has no profile env of its own.
 */
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
  // A profile can exist only in the XDG data home, e.g. when OMP used a
  // different PI_CONFIG_DIR than this process.
  const entries = [profilesDir, ...(xdgProfilesDir ? [xdgProfilesDir] : [])].flatMap((dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
  })
  const dirs: string[] = []
  for (const entry of entries) {
    if (entry.name === 'default' || !entry.isDirectory() || !isSafeProfileName(entry.name)) {
      continue
    }
    // Local agent layout plus the POSIX XDG data-home variant, when one is set.
    const candidates = [
      join(profilesDir, entry.name, 'agent', 'sessions'),
      ...(xdgProfilesDir ? [join(xdgProfilesDir, entry.name, 'sessions')] : [])
    ]
    for (const dir of candidates) {
      if (existsSync(dir)) {
        dirs.push(dir)
      }
    }
  }
  return dirs.sort().filter((dir, index) => dirs.indexOf(dir) === index)
}
