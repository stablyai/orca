import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { splitWorktreeId } from '../../shared/worktree/id'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import type { LineageDiscoverySettings } from '../../shared/lineage-discovery-types'
import { listWorktrees } from '../git/worktree'
import { extractKeysWithPattern, type ExtractedKeys } from './lineage-key-extraction'
import type { LineagePatternScanCache } from './lineage-pattern-scan-cache'
import type { LineageStoreContract } from './workspace-lineage-service'

const BRANCH_REF_PREFIX = 'refs/heads/'

export type TowerNameOptions = {
  listWorktreesFn?: (repoPath: string) => Promise<GitWorktreeInfo[]>
  patternScanCache?: LineagePatternScanCache
  force?: boolean
}

function lastPathSegment(value: string): string {
  const segments = value.split(/[\\/]+/).filter(Boolean)
  return segments.at(-1) ?? ''
}

async function readLocalBranch(
  repoPath: string,
  worktreePath: string,
  options: TowerNameOptions
): Promise<string> {
  const list = options.listWorktreesFn ?? listWorktrees
  const load = async (): Promise<GitWorktreeInfo[]> => {
    try {
      return await list(repoPath)
    } catch {
      return []
    }
  }
  const worktrees = options.patternScanCache
    ? await options.patternScanCache.getOrLoad(repoPath, load, options.force)
    : await load()
  const branch = worktrees.find((worktree) => worktree.path === worktreePath)?.branch ?? ''
  return branch.startsWith(BRANCH_REF_PREFIX) ? branch.slice(BRANCH_REF_PREFIX.length) : branch
}

/**
 * The tower's display name from the store: folder name, or `${branch} ${worktree dir name}`.
 * invariant: never the full path or an opaque id, so path segments like node-18 never become keys.
 */
export async function resolveTowerName(
  store: LineageStoreContract,
  parentWorkspaceKey: string,
  options: TowerNameOptions = {}
): Promise<string | null> {
  const scope = parseWorkspaceKey(parentWorkspaceKey)
  if (scope?.type === 'folder') {
    return store.getFolderWorkspace?.(scope.folderWorkspaceId)?.name ?? null
  }
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : parentWorkspaceKey
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed?.worktreePath) {
    return null
  }
  const repo = store.getRepos?.().find((candidate) => candidate.id === parsed.repoId)
  let branch = store.getWorktree?.(worktreeId)?.branch ?? ''
  // hazard: a remote repo's git runs on its host (SSH boundary), so its tower name is the dir name only
  if (!branch && repo && !repo.connectionId) {
    branch = await readLocalBranch(repo.path, parsed.worktreePath, options)
  }
  return [branch, lastPathSegment(parsed.worktreePath)].filter(Boolean).join(' ')
}

export type DerivedTowerKeys = ExtractedKeys & { towerName: string | null }

/** invariant: the single key derivation behind both Source Control status and the members list. */
export async function deriveTowerKeys(
  store: LineageStoreContract,
  parentWorkspaceKey: string,
  settings: LineageDiscoverySettings,
  options: TowerNameOptions & { ticketKeys?: unknown } = {}
): Promise<DerivedTowerKeys> {
  const towerName = await resolveTowerName(store, parentWorkspaceKey, options)
  if (towerName !== null) {
    return { ...extractKeysWithPattern(towerName, settings.keyRegex), towerName }
  }
  // why: older renderers sent keys for towers this host cannot name; honoured only then
  const fromRenderer = Array.isArray(options.ticketKeys)
    ? options.ticketKeys.filter((key): key is string => typeof key === 'string' && key.length > 0)
    : []
  return { keys: fromRenderer, towerName }
}
