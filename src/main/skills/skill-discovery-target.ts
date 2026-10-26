import {
  projectWslSkillDiscovery,
  type WslSkillDiscoveryObservation
} from './skill-discovery-wsl-observation'
import type { Repo } from '../../shared/repo-types'
import type { SkillDiscoveryResult, SkillDiscoveryTarget } from '../../shared/skills'
import { getDefaultWslDistro, getWslHomeAsync, parseWslPath, toLinuxPath } from '../wsl'
import { clearSkillRootScanCache, discoverSkills } from './discovery'
import { discoverSkillObservationInWsl } from './skill-discovery-wsl'
import type { SkillProviderRootOverrides } from './skill-provider-destinations'
import { stablePathId } from './skill-discovery-sources'
import { skillScanSourceKinds } from './skill-discovery-source-filter'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { isSkillRootUnavailableError, SkillScanCoalescer } from './skill-scan-coalescer'

// Cache whole WSL results to amortize process boots; native roots already cache, so only coalesce concurrent targets.
const WSL_RESULT_TTL_MS = 10_000
const MAX_CACHED_SKILL_TARGETS = 32

type TargetScanObservation =
  | { kind: 'native'; result: SkillDiscoveryResult }
  | { kind: 'wsl'; observation: WslSkillDiscoveryObservation }
const targetScans = new SkillScanCoalescer<TargetScanObservation>(MAX_CACHED_SKILL_TARGETS)

/** Invalidate whole-target and root scans after disk mutations. */
export function clearSkillDiscoveryCaches(): void {
  targetScans.clear()
  clearSkillRootScanCache()
}

export type ResolvedSkillDiscoveryTarget =
  | {
      kind: 'native-host'
      cwd: string | undefined
      names?: string[]
      sourceKinds?: SkillDiscoveryTarget['sourceKinds']
    }
  | {
      kind: 'wsl'
      distro: string
      homeDir: string
      cwd: string | undefined
      names?: string[]
      sourceKinds?: SkillDiscoveryTarget['sourceKinds']
    }

export async function resolveSkillDiscoveryTarget(
  target: SkillDiscoveryTarget | undefined
): Promise<ResolvedSkillDiscoveryTarget> {
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
    return {
      kind: 'native-host',
      cwd: target?.cwd?.trim() || undefined,
      ...(target?.names ? { names: target.names } : {}),
      ...(target?.sourceKinds ? { sourceKinds: target.sourceKinds } : {})
    }
  }
  if (process.platform !== 'win32') {
    throw new Error('WSL skill discovery is only available on Windows.')
  }
  // Why async: a synchronous probe blocks main and, on a booting distro, kills its first boot.
  const homeDir = await getWslHomeAsync(wslDistro)
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
  const cwd = parsedCwd?.linuxPath ?? (requestedCwd ? toLinuxPath(requestedCwd) : undefined)
  return {
    kind: 'wsl',
    distro: wslDistro,
    homeDir: linuxHomeDir,
    cwd,
    ...(target?.names ? { names: target.names } : {}),
    ...(target?.sourceKinds ? { sourceKinds: target.sourceKinds } : {})
  }
}

// Repo sets widen native discovery; digest paths to bound key size.
function repoDigest(repos: readonly Repo[]): string {
  return stablePathId(
    repos
      // Execution host changes which repos are locally scannable even when their paths match.
      .map((repo) => `${getRepoExecutionHostId(repo)}\0${repo.path}`)
      .sort((left, right) => left.localeCompare(right))
      // NUL cannot occur in paths, preventing ambiguous joined repo lists.
      .join('\0')
  )
}

// Keys use exact paths — lowercasing would alias two roots that are distinct on Linux.
function scanKey(
  target: ResolvedSkillDiscoveryTarget,
  repos: readonly Repo[],
  providerRootOverrides: SkillProviderRootOverrides | undefined
): string {
  const providerRoots = Object.entries(providerRootOverrides ?? {}).sort(([left], [right]) =>
    left.localeCompare(right)
  )
  const names = target.names?.slice().sort() ?? null
  const sourceKinds = target.sourceKinds?.slice().sort() ?? null
  return target.kind === 'wsl'
    ? JSON.stringify([
        'wsl',
        target.distro,
        target.homeDir,
        target.cwd ?? null,
        providerRoots,
        skillScanSourceKinds(target.sourceKinds) ?? null
      ])
    : JSON.stringify([
        'native',
        target.cwd ?? null,
        target.cwd ? null : repoDigest(repos),
        providerRoots,
        names,
        sourceKinds
      ])
}

export async function discoverSkillsOnTarget(
  target: ResolvedSkillDiscoveryTarget,
  repos: readonly Repo[],
  options: { refresh?: boolean; providerRootOverrides?: SkillProviderRootOverrides } = {}
): Promise<SkillDiscoveryResult> {
  const refresh = options.refresh === true
  try {
    const outcome = await targetScans.run(
      scanKey(target, repos, options.providerRootOverrides),
      { ttlMs: target.kind === 'wsl' ? WSL_RESULT_TTL_MS : 0, refresh },
      async (): Promise<TargetScanObservation> => {
        if (target.kind === 'wsl') {
          return {
            kind: 'wsl',
            observation: await discoverSkillObservationInWsl({
              distro: target.distro,
              homeDir: target.homeDir,
              ...(target.cwd ? { cwd: target.cwd } : {}),
              sourceKinds: skillScanSourceKinds(target.sourceKinds),
              providerRootOverrides: options.providerRootOverrides
            })
          }
        }
        const result = await (target.cwd
          ? discoverSkills({
              repos: [],
              cwd: target.cwd,
              refresh,
              ...(target.names ? { names: target.names } : {}),
              ...(target.sourceKinds ? { sourceKinds: target.sourceKinds } : {}),
              providerRootOverrides: options.providerRootOverrides
            })
          : discoverSkills({
              repos: [...repos],
              refresh,
              ...(target.names ? { names: target.names } : {}),
              ...(target.sourceKinds ? { sourceKinds: target.sourceKinds } : {}),
              providerRootOverrides: options.providerRootOverrides
            }))
        return { kind: 'native', result }
      }
    )
    return outcome.value.kind === 'wsl'
      ? projectWslSkillDiscovery(outcome.value.observation, target.sourceKinds, target.names)
      : outcome.value.result
  } catch (error) {
    if (!isSkillRootUnavailableError(error)) {
      throw error
    }
    // A failed target scan has no partial answer; zero skills would falsely imply uninstall. Preserve retryable error.
    throw new Error('Skill discovery is still reading a slow location. Try again.', {
      cause: error
    })
  }
}
