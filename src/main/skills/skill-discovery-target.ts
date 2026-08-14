import type { Repo } from '../../shared/types'
import type { SkillDiscoveryResult, SkillDiscoveryTarget } from '../../shared/skills'
import { getDefaultWslDistro, getWslHome, parseWslPath, toLinuxPath } from '../wsl'
import { clearSkillRootScanCache, discoverSkills } from './discovery'
import { discoverSkillsInWsl } from './skill-discovery-wsl'
import { stablePathId } from './skill-discovery-sources'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { SkillScanCoalescer } from './skill-scan-coalescer'

// Why: on WSL the unit of cost is the wsl.exe boot plus one `find` per skill, so
// the whole result is what must be shared. The native path shares at root level
// instead, and only needs concurrent callers collapsed into one walk.
const WSL_RESULT_TTL_MS = 10_000
const MAX_CACHED_SKILL_TARGETS = 32

const targetScans = new SkillScanCoalescer<SkillDiscoveryResult>(MAX_CACHED_SKILL_TARGETS)

/** Drop every shared scan; used when a skill update run has rewritten disk. */
export function clearSkillDiscoveryCaches(): void {
  targetScans.clear()
  clearSkillRootScanCache()
}

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

// Why: repos widen the native root set, so two targets that differ only by the
// stored repo list must not share a scan. Paths are digested rather than joined
// so the key cannot grow with a large repo list.
function repoDigest(repos: readonly Repo[]): string {
  return stablePathId(
    repos
      // Why: the source builder keeps only locally-executed repos, so the same
      // path reassigned to another execution host is a different root set.
      .map((repo) => `${getRepoExecutionHostId(repo)}\0${repo.path}`)
      .sort((left, right) => left.localeCompare(right))
      // NUL is the one byte a path cannot contain, so no repo list can be spelled
      // two ways that digest alike.
      .join('\0')
  )
}

// Keys use exact paths — lowercasing would alias two roots that are distinct on Linux.
function scanKey(target: ResolvedSkillDiscoveryTarget, repos: readonly Repo[]): string {
  return target.kind === 'wsl'
    ? `wsl\0${target.distro}\0${target.homeDir}\0${target.cwd}`
    : `native\0${target.cwd ?? ''}\0${target.cwd ? '' : repoDigest(repos)}`
}

export async function discoverSkillsOnTarget(
  target: ResolvedSkillDiscoveryTarget,
  repos: readonly Repo[],
  options: { refresh?: boolean } = {}
): Promise<SkillDiscoveryResult> {
  const refresh = options.refresh === true
  const outcome = await targetScans.run(
    scanKey(target, repos),
    { ttlMs: target.kind === 'wsl' ? WSL_RESULT_TTL_MS : 0, refresh },
    async () => {
      if (target.kind === 'wsl') {
        return discoverSkillsInWsl({
          distro: target.distro,
          homeDir: target.homeDir,
          cwd: target.cwd
        })
      }
      return target.cwd
        ? discoverSkills({ repos: [], cwd: target.cwd, refresh })
        : discoverSkills({ repos: [...repos], refresh })
    }
  )
  return outcome.value
}
