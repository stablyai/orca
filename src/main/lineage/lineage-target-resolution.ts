import fs from 'node:fs'
import path from 'node:path'
import { splitWorktreeId, WORKTREE_ID_SEPARATOR } from '../../shared/worktree/id'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import type { LineageMatchSource } from '../../shared/lineage-discovery-types'
import { getDefaultWorkspacesRoot } from './workspaces-fs-watcher'
import { resolveEffectiveDiscoverySettings } from './lineage-discovery-settings'
import { discoverPatternTargets } from './lineage-name-pattern-discovery'
import { deriveTowerKeys } from './lineage-tower-name'
import type { LineagePatternScanCache } from './lineage-pattern-scan-cache'
import type { LineageStoreContract } from './workspace-lineage-service'

export type ResolvedWorktreeTarget = {
  worktreeId: string
  repoName: string
  branchHint: string
  worktreePath: string
  matchedBy?: LineageMatchSource
  reasons?: string[]
  isTower?: boolean
  /** hazard: remote (SSH) worktree; this host cannot check its files. */
  unverifiable?: boolean
}

export function resolveWorktreeTarget(
  childWorkspaceKey: string,
  store: LineageStoreContract,
  customResolver?: (worktreeId: string, repoName: string, branch: string) => string | null
): ResolvedWorktreeTarget | null {
  const worktreeId = childWorkspaceKey.startsWith('worktree:')
    ? childWorkspaceKey.slice('worktree:'.length)
    : childWorkspaceKey

  let repoName = 'unknown'
  let branchHint = 'main'
  let candidatePath: string | null = null

  const parsed = splitWorktreeId(worktreeId)
  if (parsed) {
    repoName = parsed.repoId
    candidatePath = parsed.worktreePath
  } else if (worktreeId.includes(':')) {
    const colonParts = worktreeId.split(':')
    repoName = colonParts[0]
    branchHint = colonParts.slice(1).join(':')
  } else {
    branchHint = worktreeId
  }

  const wt = store.getWorktree?.(worktreeId)
  if (wt?.path) {
    candidatePath = wt.path
    if (wt.repoId) {
      repoName = wt.repoId
    }
    if (wt.branch) {
      branchHint = wt.branch
    }
  }

  if (customResolver) {
    const resolved = customResolver(worktreeId, repoName, branchHint)
    if (resolved) {
      candidatePath = resolved
    }
  }

  if (!candidatePath) {
    const standardPath = path.join(getDefaultWorkspacesRoot(), repoName, branchHint)
    if (fs.existsSync(standardPath)) {
      candidatePath = standardPath
    } else if (path.isAbsolute(branchHint) && fs.existsSync(branchHint)) {
      candidatePath = branchHint
    }
  }

  // invariant: one repository, one name, so Source Control groups lineage and pattern worktrees together
  const registered = store.getRepos?.().find((repo) => repo.id === repoName)

  // hazard: a remote worktree's path lives on its SSH host; local fs absence is not evidence it is gone
  if (registered?.connectionId && candidatePath) {
    return {
      worktreeId,
      repoName: registered.displayName,
      branchHint,
      worktreePath: candidatePath,
      unverifiable: true
    }
  }

  if (!candidatePath || !fs.existsSync(candidatePath)) {
    return null
  }

  return {
    worktreeId,
    repoName: registered?.displayName ?? repoName,
    branchHint,
    worktreePath: path.resolve(candidatePath)
  }
}

export type ResolveLineageTargetsOptions = {
  worktreePathResolver?: (worktreeId: string, repoName: string, branch: string) => string | null
  listWorktreesFn?: (repoPath: string) => Promise<GitWorktreeInfo[]>
  /** Keys from older renderers; used only when this host cannot name the tower itself. */
  ticketKeys?: unknown
  patternScanCache?: LineagePatternScanCache
  force?: boolean
}

export type ResolvedLineageTargets = {
  targets: ResolvedWorktreeTarget[]
  keys: string[]
  patternError?: string
}

/** invariant: the single resolution of lineage + pattern worktrees; Source Control and the member resolver both call it. */
export async function resolveLineageTargets(
  store: LineageStoreContract,
  parentWorkspaceKey: string,
  options: ResolveLineageTargetsOptions = {}
): Promise<ResolvedLineageTargets> {
  const settings = resolveEffectiveDiscoverySettings(store.getSettings?.().lineageDiscovery)
  const derived = await deriveTowerKeys(store, parentWorkspaceKey, settings, options)
  const keys = derived.keys
  const targets: ResolvedWorktreeTarget[] = []
  const knownPaths = new Set<string>()

  if (settings.lineageEnabled) {
    const allLineages =
      (typeof store.getAllWorkspaceLineage === 'function' && store.getAllWorkspaceLineage()) ||
      (typeof store.getState === 'function' && store.getState()?.workspaceLineageByChildKey) ||
      {}
    const childEntries = Object.values(allLineages).filter(
      (lineage) => lineage && lineage.parentWorkspaceKey === parentWorkspaceKey
    )
    for (const entry of childEntries) {
      const target = resolveWorktreeTarget(
        entry.childWorkspaceKey,
        store,
        options.worktreePathResolver
      )
      if (target) {
        targets.push({
          ...target,
          matchedBy: 'lineage',
          reasons: ['attached to this workspace']
        })
        knownPaths.add(target.worktreePath)
      }
    }
  }

  const parentTarget = parentWorkspaceKey.startsWith('folder:')
    ? null
    : resolveWorktreeTarget(parentWorkspaceKey, store, options.worktreePathResolver)
  // invariant: the tower's own worktree is always listed first so its changes show beside its children
  if (parentTarget && !knownPaths.has(parentTarget.worktreePath)) {
    targets.unshift({
      ...parentTarget,
      matchedBy: 'lineage',
      reasons: ['this workspace'],
      isTower: true
    })
    knownPaths.add(parentTarget.worktreePath)
  }

  if (settings.patternEnabled) {
    const patternTargets = await discoverPatternTargets({
      repos: store.getRepos?.() ?? [],
      keys,
      excludePaths: [...knownPaths],
      matchOn: settings.matchOn,
      repoScope: settings.repoScope,
      listWorktreesFn: options.listWorktreesFn,
      patternScanCache: options.patternScanCache,
      force: options.force
    })
    for (const found of patternTargets) {
      targets.push({
        // invariant: the store's worktree id, so renderer diff-open resolves the right worktree
        worktreeId: `${found.repoId}${WORKTREE_ID_SEPARATOR}${found.worktreePath}`,
        repoName: found.repoName,
        branchHint: found.branch,
        worktreePath: found.worktreePath,
        matchedBy: 'pattern',
        reasons: [`${found.matchedOn} matches ${found.matchedKey}`]
      })
    }
  }

  return derived.error ? { targets, keys, patternError: derived.error } : { targets, keys }
}
