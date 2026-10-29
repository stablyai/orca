import type {
  SkillDiscoveryResult,
  SkillDiscoverySource,
  SkillSourceKind
} from '../../shared/skills'
import {
  blockedWslDistroForPath,
  wslDistroForPath,
  WslDistroStoppedError,
  WslDistroUnverifiableError
} from '../wsl/wsl-unc-access-gate'
import { stablePathId, type SkillScanRoot } from './skill-discovery-sources'

const ALL_SOURCE_KINDS: readonly SkillSourceKind[] = ['home', 'repo', 'bundled', 'plugin']

/** A root left unread; 'unavailable' tells the UI its skills are unknown, never absent. */
export function unavailableSkillSource(root: SkillScanRoot): SkillDiscoverySource {
  return { ...root, providers: [...root.providers], exists: false, skippedReason: 'unavailable' }
}

/**
 * Splits off roots on a stopped (or unverifiable) WSL distro: reading `\\wsl.localhost` would start
 * it, and passive UI runs this scan. The caller reports them unavailable, so the next scan reads them.
 */
export async function splitStoppedWslDistroRoots(
  roots: readonly SkillScanRoot[],
  /** Roots a user act may read even on a stopped distro; they never ask the gate. */
  mayReadStopped: (path: string) => boolean = () => false
): Promise<{ readable: SkillScanRoot[]; unavailable: SkillScanRoot[] }> {
  const blockedByDistro = new Map<string, Promise<boolean>>()
  const blocked = await Promise.all(
    roots.map(async (root) => {
      const distro = wslDistroForPath(root.path)
      if (!distro || mayReadStopped(root.path)) {
        return false
      }
      const key = distro.toLowerCase()
      let check = blockedByDistro.get(key)
      if (!check) {
        check = blockedWslDistroForPath(root.path).then((result) => result !== null)
        blockedByDistro.set(key, check)
      }
      return await check
    })
  )
  return {
    readable: roots.filter((_, index) => !blocked[index]),
    unavailable: roots.filter((_, index) => blocked[index])
  }
}

// Lowercasing can only widen the user-act-readable roots: Windows treats these UNC paths case-insensitively.
function comparablePath(path: string): string {
  return path
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase()
}

/** Stopped WSL roots a user act may read: every one, those on named distros, or those holding chosen skill directories. */
export type StoppedWslRootsReadScope = 'all' | { distros: readonly string[] } | readonly string[]

/** Distinguishes scans with different read scopes in the scan coalescer. */
export function stoppedWslRootsReadScopeKey(scope: StoppedWslRootsReadScope): string {
  if (scope === 'all') {
    return 'all'
  }
  if ('distros' in scope) {
    const distros = scope.distros.map((distro) => distro.toLowerCase())
    return `distros:${stablePathId([...distros].sort().join('\0'))}`
  }
  return stablePathId([...scope].sort().join('\0'))
}

/** Whether a stopped-distro root or plugin cwd at `path` falls in the user act's read scope. */
export function stoppedRootReader(
  readFor: StoppedWslRootsReadScope | undefined
): (path: string) => boolean {
  if (readFor === 'all') {
    return () => true
  }
  if (readFor !== undefined && 'distros' in readFor) {
    const distros = new Set(readFor.distros.map((distro) => distro.toLowerCase()))
    return (path) => distros.has(wslDistroForPath(path)?.toLowerCase() ?? '')
  }
  const directories = (readFor ?? []).map(comparablePath)
  return (path) => {
    const root = comparablePath(path)
    // `/` or `\\` normalizes to '', which would prefix every directory.
    if (root === '') {
      return false
    }
    return directories.some((directory) => directory === root || directory.startsWith(`${root}/`))
  }
}

/** Whether reading `path` would start a stopped (or unverifiable) WSL distro. */
export async function isOnStoppedWslDistro(path: string): Promise<boolean> {
  return wslDistroForPath(path) !== null && (await blockedWslDistroForPath(path)) !== null
}

/**
 * Discovery for a WSL target whose distro is stopped (or unverifiable) answers "unknown": no skills,
 * and an unavailable source per requested kind, so no surface reads the skills as not installed.
 */
export async function unavailableWhileWslDistroStopped(
  discover: () => Promise<SkillDiscoveryResult>,
  sourceKinds?: readonly SkillSourceKind[]
): Promise<SkillDiscoveryResult> {
  try {
    return await discover()
  } catch (error) {
    if (!(error instanceof WslDistroStoppedError || error instanceof WslDistroUnverifiableError)) {
      throw error
    }
    const kinds = sourceKinds?.length ? sourceKinds : ALL_SOURCE_KINDS
    return {
      skills: [],
      sources: kinds.map((sourceKind) =>
        unavailableSkillSource({
          id: `wsl-unavailable-${sourceKind}-${error.distro.toLowerCase()}`,
          label: `WSL ${error.distro}`,
          path: '',
          sourceKind,
          providers: [],
          owner: null
        })
      ),
      scannedAt: Date.now()
    }
  }
}

// Plugin roots are listed from the workspace itself; on a stopped distro only their kind is known.
export function stoppedPluginRoot(cwd: string): SkillScanRoot {
  return {
    id: `plugin-unavailable-${stablePathId(cwd)}`,
    label: 'Claude plugins',
    path: cwd,
    sourceKind: 'plugin',
    providers: ['claude'],
    owner: 'claude'
  }
}
