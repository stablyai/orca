import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  BUILT_IN_AGENT_LAUNCH_PROFILES,
  agentLaunchProfileHomeMarkerEnv,
  type AgentLaunchProfile,
  type AgentLaunchProfileHome
} from '../../shared/agent-launch-profile/agent-launch-profile'
import { getDefaultWslDistro, getWslHome, parseWslPath } from '../wsl'
import { addWslEnvKeys } from '../wsl-env'

// Why: shell-ready wrappers restore CODEX_HOME from ORCA_CODEX_HOME after profile scripts, so a
// relocated Codex home must set both. Claude Code reads CLAUDE_CONFIG_DIR directly.
const MIRROR_ENV_VARS: Readonly<Record<string, readonly string[]>> = {
  CODEX_HOME: ['ORCA_CODEX_HOME']
}

export type SecondaryHomeProfile = AgentLaunchProfile & { home: AgentLaunchProfileHome }

/** Only built-in profiles relocate a home; custom profiles carry args/env and no marker. */
export const SECONDARY_HOME_PROFILES: readonly SecondaryHomeProfile[] =
  BUILT_IN_AGENT_LAUNCH_PROFILES.filter(
    (profile): profile is SecondaryHomeProfile => profile.home !== undefined
  )

/** The secondary-home profiles a launch env carries a marker for. */
export function requestedSecondaryHomeProfiles(
  env: Readonly<Record<string, string>>
): SecondaryHomeProfile[] {
  return SECONDARY_HOME_PROFILES.filter(
    (profile) => env[agentLaunchProfileHomeMarkerEnv(profile.home.envVar)] === profile.id
  )
}

/** Writes the resolved home, its mirrors, and drops the marker the launch carried. */
export function assignLaunchProfileHome(
  env: Record<string, string>,
  profile: SecondaryHomeProfile,
  home: string
): void {
  delete env[agentLaunchProfileHomeMarkerEnv(profile.home.envVar)]
  env[profile.home.envVar] = home
  for (const mirror of MIRROR_ENV_VARS[profile.home.envVar] ?? []) {
    env[mirror] = home
  }
}

export type LaunchProfileHomeHostContext = {
  hostEnv?: NodeJS.ProcessEnv
  hostHome?: string
}

/** Absolute home for a secondary-home profile on the machine that runs the PTY. */
export function resolveLaunchProfileHostHome(
  home: AgentLaunchProfileHome,
  context: LaunchProfileHomeHostContext = {}
): string {
  const configured = (context.hostEnv ?? process.env)[home.overrideEnv]?.trim()
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error(`${home.overrideEnv} must be an absolute path on the execution host.`)
    }
    return configured
  }
  return join(context.hostHome ?? homedir(), home.dirName)
}

function resolveLaunchProfileWslHome(
  profile: SecondaryHomeProfile,
  distro: string | null | undefined
): string {
  const target = distro?.trim() || getDefaultWslDistro()
  const wslHome = target ? getWslHome(target) : null
  if (!wslHome) {
    throw new Error(`${profile.label} could not resolve the selected WSL home directory.`)
  }
  return join(wslHome, profile.home.dirName)
}

/**
 * Turns every secondary-home marker a launch carries into a real home directory.
 *
 * The launch only ships a marker; only the execution host knows the real path. A WSL launch
 * gets the distro home as a UNC path, which the caller's existing WSL translation rewrites to
 * a Linux path and exports through WSLENV.
 */
export function applyLaunchProfileHomeMarkers(args: {
  env: Record<string, string>
  isWslLaunch?: boolean
  wslDistro?: string | null
  hostEnv?: NodeJS.ProcessEnv
  hostHome?: string
}): void {
  for (const profile of requestedSecondaryHomeProfiles(args.env)) {
    // Why: main may already have injected the selected managed home; the explicit profile wins.
    assignLaunchProfileHome(
      args.env,
      profile,
      args.isWslLaunch
        ? resolveLaunchProfileWslHome(profile, args.wslDistro)
        : resolveLaunchProfileHostHome(profile.home, args)
    )
  }
}

/**
 * Rewrites a resolved WSL home (a `\\wsl.localhost\...` UNC path) to the Linux path the distro
 * shell needs and exports it through WSLENV. The daemon lane does this inside its own WSL
 * translation; the in-process lane resolves markers after that translation ran, so it calls this.
 */
export function exportLaunchProfileHomesForWsl(env: Record<string, string>): void {
  for (const profile of SECONDARY_HOME_PROFILES) {
    const value = env[profile.home.envVar]
    const wslInfo = value ? parseWslPath(value) : null
    if (!wslInfo) {
      continue
    }
    env[profile.home.envVar] = wslInfo.linuxPath
    for (const mirror of MIRROR_ENV_VARS[profile.home.envVar] ?? []) {
      env[mirror] = wslInfo.linuxPath
    }
    addWslEnvKeys(env, [profile.home.envVar, ...(MIRROR_ENV_VARS[profile.home.envVar] ?? [])])
  }
}

/** Same resolution for read-only scanners, which must not fail a scan over one bad override. */
export function launchProfileHostHomeOrNull(
  profileId: string,
  context: LaunchProfileHomeHostContext = {}
): string | null {
  const profile = SECONDARY_HOME_PROFILES.find((candidate) => candidate.id === profileId)
  if (!profile) {
    return null
  }
  try {
    return resolveLaunchProfileHostHome(profile.home, context)
  } catch {
    return null
  }
}
