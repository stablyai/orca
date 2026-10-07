import type { LineageMember } from '../../shared/lineage-discovery-types'
import {
  resolveLineageTargets,
  type ResolveLineageTargetsOptions
} from './lineage-target-resolution'
import { mergeLineageMembers } from './lineage-member-merge'
import { resolveManualLinkMembers } from './lineage-manual-link-resolution'
import {
  createLineagePatternScanCache,
  scopeLineageScanToRequest
} from './lineage-pattern-scan-cache'
import type { LineageStoreContract } from './workspace-lineage-service'

export type ResolvedLineageMembers = {
  members: LineageMember[]
  keys: string[]
  patternError?: string
}

export async function resolveLineageMembers(
  store: LineageStoreContract,
  parentWorkspaceKey: string,
  options: ResolveLineageTargetsOptions = {}
): Promise<ResolvedLineageMembers> {
  const patternScanCache = scopeLineageScanToRequest(
    options.patternScanCache ?? createLineagePatternScanCache()
  )
  const { targets, keys, patternError } = await resolveLineageTargets(store, parentWorkspaceKey, {
    ...options,
    patternScanCache
  })
  const fromWorktrees: LineageMember[] = targets.map((target) => ({
    repoName: target.repoName,
    branch: target.branchHint,
    worktreePath: target.worktreePath,
    worktreeId: target.worktreeId,
    matchedBy: target.matchedBy ?? 'lineage',
    reasons: target.reasons ?? [],
    ...(target.isTower ? { isTower: true } : {}),
    ...(target.unverifiable ? { unverifiable: true } : {})
  }))
  const manual = await resolveManualLinkMembers(
    store.getLineageManualLinks?.(parentWorkspaceKey) ?? [],
    store.getRepos?.() ?? [],
    {
      listWorktreesFn: options.listWorktreesFn,
      patternScanCache,
      force: options.force
    }
  )
  const members = mergeLineageMembers([...fromWorktrees, ...manual])
  return patternError ? { members, keys, patternError } : { members, keys }
}
