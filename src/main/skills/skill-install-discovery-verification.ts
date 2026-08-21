import { dirname, posix, resolve } from 'node:path'
import type { SkillInstallResult, SkillPlacementResult } from '../../shared/skill-install-contract'
import type { DiscoveredSkill, SkillDiscoveryResult } from '../../shared/skills'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { discoverSkills } from './discovery'
import { discoverSkillsInWsl } from './skill-discovery-wsl'
import type { SkillProviderRootOverrides } from './skill-provider-destinations'

function toWslDiscoveryPath(path: string, distro: string): string {
  if (path.includes('\0')) {
    throw new Error('skill-install-wsl-path-invalid')
  }
  const parsed = parseWslUncPath(path)
  if (parsed) {
    if (parsed.distro.toLocaleLowerCase('en-US') !== distro.toLocaleLowerCase('en-US')) {
      throw new Error('skill-install-wsl-distro-mismatch')
    }
    return posix.normalize(parsed.linuxPath)
  }
  const slashed = path.replace(/\\/g, '/')
  const drive = slashed.match(/^([A-Za-z]):\/(.*)$/)
  if (drive) {
    return posix.join('/mnt', drive[1].toLocaleLowerCase('en-US'), drive[2])
  }
  if (!posix.isAbsolute(slashed)) {
    throw new Error('skill-install-wsl-path-invalid')
  }
  return posix.normalize(slashed)
}

function normalizedPath(path: string, wslDistro?: string): string {
  const normalized = wslDistro ? toWslDiscoveryPath(path, wslDistro) : resolve(path)
  const withoutTrailingSlash =
    wslDistro && normalized !== '/' ? normalized.replace(/\/+$/, '') : normalized
  return !wslDistro && process.platform === 'win32'
    ? withoutTrailingSlash.toLocaleLowerCase('en-US')
    : withoutTrailingSlash
}

function unreadableRootPaths(discovery: SkillDiscoveryResult, wslDistro?: string): Set<string> {
  return new Set(
    discovery.sources
      .filter((source) => source.skippedReason === 'unavailable')
      .map((source) => normalizedPath(source.path, wslDistro))
  )
}

/**
 * Whether a root that actually answered reached this skill.
 *
 * Why verification cannot reuse discovery's leniency: a root that did not answer
 * is served from the host's last completed scan, which is the state *before* this
 * install wrote. Counting that as proof would report a reinstall as verified
 * without reading a byte of what it just wrote. A co-owning root that did answer
 * is still proof, so a symlinked placement verifies as before.
 */
function isAnsweredSkill(
  skill: DiscoveredSkill,
  unreadableRoots: ReadonlySet<string>,
  wslDistro?: string
): boolean {
  if (unreadableRoots.size === 0) {
    return true
  }
  return (skill.rootPaths ?? [skill.rootPath]).some(
    (rootPath) => !unreadableRoots.has(normalizedPath(rootPath, wslDistro))
  )
}

function placementIsDiscovered(
  discovery: SkillDiscoveryResult,
  placement: SkillPlacementResult,
  skillName: string,
  wslDistro?: string
): boolean {
  const placementPath = normalizedPath(placement.path, wslDistro)
  const placementRoot = normalizedPath(
    wslDistro ? posix.dirname(placementPath) : dirname(placement.path),
    wslDistro
  )
  const unreadableRoots = unreadableRootPaths(discovery, wslDistro)
  return discovery.skills.some((skill) => {
    if (skill.name !== skillName) {
      return false
    }
    if (!isAnsweredSkill(skill, unreadableRoots, wslDistro)) {
      return false
    }
    if (normalizedPath(skill.directoryPath, wslDistro) === placementPath) {
      return true
    }
    return (skill.rootPaths ?? [skill.rootPath]).some(
      (root) => normalizedPath(root, wslDistro) === placementRoot
    )
  })
}

async function discoverInstalledSkill(input: {
  scope: 'global' | 'workspace'
  homeDirectory: string
  workspaceDirectory?: string
  wslDistro?: string
  providerRootOverrides?: SkillProviderRootOverrides
}): Promise<SkillDiscoveryResult> {
  if (input.wslDistro) {
    const wslDistro = input.wslDistro
    const providerRootOverrides = input.providerRootOverrides
      ? Object.fromEntries(
          Object.entries(input.providerRootOverrides).map(([provider, root]) => [
            provider,
            toWslDiscoveryPath(root, wslDistro)
          ])
        )
      : undefined
    return discoverSkillsInWsl({
      distro: wslDistro,
      homeDir: toWslDiscoveryPath(input.homeDirectory, wslDistro),
      cwd: toWslDiscoveryPath(input.workspaceDirectory ?? input.homeDirectory, wslDistro),
      ...(providerRootOverrides ? { providerRootOverrides } : {})
    })
  }
  return discoverSkills({
    homeDir: input.homeDirectory,
    repos: [],
    refresh: true,
    ...(input.scope === 'workspace' && input.workspaceDirectory
      ? { cwd: input.workspaceDirectory }
      : { includeCwd: false }),
    ...(input.providerRootOverrides ? { providerRootOverrides: input.providerRootOverrides } : {})
  })
}

export async function verifySkillInstallDiscovery(input: {
  result: SkillInstallResult
  scope: 'global' | 'workspace'
  homeDirectory: string
  workspaceDirectory?: string
  wslDistro?: string
  providerRootOverrides?: SkillProviderRootOverrides
  discover?: () => Promise<SkillDiscoveryResult>
}): Promise<SkillInstallResult> {
  const discovery = await (input.discover?.() ?? discoverInstalledSkill(input)).catch(() => null)
  if (!discovery) {
    return {
      ...input.result,
      status: 'failed',
      errorCategory: 'skill-discovery-verification-failed',
      failure: {
        category: 'provider-placement',
        code: 'skill-discovery-verification-failed',
        retryable: true
      }
    }
  }

  const placements = input.result.placements.map((placement) => {
    if (
      (placement.status !== 'installed' && placement.status !== 'unchanged') ||
      placementIsDiscovered(discovery, placement, input.result.name, input.wslDistro)
    ) {
      return placement
    }
    return {
      ...placement,
      status: 'failed' as const,
      errorCategory: 'skill-discovery-placement-missing',
      failure: {
        category: 'provider-placement' as const,
        code: 'skill-discovery-placement-missing',
        retryable: true
      }
    }
  })
  const canonical = placements.find((placement) => placement.topology === 'canonical-copy')
  if (!canonical || canonical.status === 'failed') {
    return {
      ...input.result,
      status: 'failed',
      placements,
      errorCategory: 'skill-discovery-canonical-missing',
      failure: {
        category: 'provider-placement',
        code: 'skill-discovery-canonical-missing',
        retryable: true
      }
    }
  }
  return {
    ...input.result,
    status: placements.some(
      (placement) => placement.status === 'failed' || placement.status === 'skipped'
    )
      ? 'partial'
      : input.result.status,
    placements
  }
}
