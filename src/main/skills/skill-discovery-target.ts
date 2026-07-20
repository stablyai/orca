import type { Repo } from '../../shared/types'
import type { SkillDiscoveryResult, SkillDiscoveryTarget } from '../../shared/skills'
import { getDefaultWslDistro, getWslHome, parseWslPath, toLinuxPath } from '../wsl'
import { discoverSkills } from './discovery'
import { discoverSkillsInWsl } from './skill-discovery-wsl'

export type ResolvedSkillDiscoveryTarget =
  | { kind: 'native-host'; cwd: string | undefined }
  | { kind: 'wsl'; distro: string; homeDir: string; cwd: string }

export function resolveSkillDiscoveryTarget(
  target: SkillDiscoveryTarget | undefined
): ResolvedSkillDiscoveryTarget {
  const projectRuntime = target?.projectRuntime
  if (projectRuntime?.status === 'repair-required') {
    throw new Error(
      `Project runtime requires repair before skill discovery: ${projectRuntime.repair.reason}`
    )
  }

  const wslRequested =
    (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl') ||
    (!projectRuntime && target?.runtime === 'wsl')
  const wslDistro =
    projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl'
      ? projectRuntime.runtime.distro
      : !projectRuntime && target?.runtime === 'wsl'
        ? target.wslDistro?.trim() || getDefaultWslDistro()
        : null
  if (wslRequested && !wslDistro) {
    throw new Error('No WSL distribution is available for skill discovery.')
  }
  if (!wslDistro) {
    return { kind: 'native-host', cwd: target?.cwd?.trim() || undefined }
  }
  if (process.platform !== 'win32') {
    throw new Error('WSL skill discovery is only available on Windows.')
  }
  const homeDir = getWslHome(wslDistro)
  if (!homeDir) {
    throw new Error(`Could not resolve the WSL home directory for ${wslDistro}.`)
  }

  const requestedCwd = target?.cwd?.trim()
  const parsedCwd = requestedCwd ? parseWslPath(requestedCwd) : null
  if (parsedCwd && parsedCwd.distro.toLowerCase() !== wslDistro.toLowerCase()) {
    throw new Error(
      `The workspace belongs to WSL distribution ${parsedCwd.distro}, not ${wslDistro}.`
    )
  }
  const linuxHomeDir = toLinuxPath(homeDir)
  const cwd = parsedCwd?.linuxPath ?? (requestedCwd ? toLinuxPath(requestedCwd) : linuxHomeDir)
  return { kind: 'wsl', distro: wslDistro, homeDir: linuxHomeDir, cwd }
}

export async function discoverSkillsOnTarget(
  target: ResolvedSkillDiscoveryTarget,
  repos: readonly Repo[]
): Promise<SkillDiscoveryResult> {
  if (target.kind === 'wsl') {
    return discoverSkillsInWsl({
      distro: target.distro,
      homeDir: target.homeDir,
      cwd: target.cwd
    })
  }
  return target.cwd
    ? discoverSkills({ repos: [], cwd: target.cwd })
    : discoverSkills({ repos: [...repos] })
}
