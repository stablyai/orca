import type { LineageMatchSource, LineageMember } from '../../shared/lineage-discovery-types'

const STRENGTH: Record<LineageMatchSource, number> = { manual: 3, lineage: 2, pattern: 1 }

// invariant: branchless manual PRs key by link id so two PRs in one repo never collapse
function memberKey(member: LineageMember): string {
  if (member.worktreePath) {
    return `wt:${member.worktreePath}`
  }
  if (member.branch || !member.manualLinkId) {
    return `br:${member.repoName}:${member.branch}`
  }
  return `ml:${member.manualLinkId}`
}

/** invariant: one row per worktree; a worktree-less member folds into the worktree row of the same repo+branch. */
export function mergeLineageMembers(members: LineageMember[]): LineageMember[] {
  const byKey = new Map<string, LineageMember>()
  const worktreeKeyByBranch = new Map<string, string>()
  for (const member of members) {
    if (member.worktreePath && member.branch) {
      worktreeKeyByBranch.set(`${member.repoName}:${member.branch}`, memberKey(member))
    }
  }
  for (const member of members) {
    const folded =
      !member.worktreePath && member.branch
        ? worktreeKeyByBranch.get(`${member.repoName}:${member.branch}`)
        : undefined
    const key = folded ?? memberKey(member)
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, { ...member, reasons: [...member.reasons] })
      continue
    }
    const stronger = STRENGTH[member.matchedBy] > STRENGTH[existing.matchedBy] ? member : existing
    byKey.set(key, {
      ...existing,
      matchedBy: stronger.matchedBy,
      worktreePath: existing.worktreePath ?? member.worktreePath,
      worktreeId: existing.worktreeId ?? member.worktreeId,
      pr: member.pr ?? existing.pr,
      manualLinkId: member.manualLinkId ?? existing.manualLinkId,
      ...(existing.isTower || member.isTower ? { isTower: true } : {}),
      ...(existing.unverifiable || member.unverifiable ? { unverifiable: true } : {}),
      reasons: [
        ...new Set(
          stronger === member
            ? [...member.reasons, ...existing.reasons]
            : [...existing.reasons, ...member.reasons]
        )
      ]
    })
  }
  return [...byKey.values()]
}
