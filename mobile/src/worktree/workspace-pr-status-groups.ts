import type { Worktree } from './workspace-list-sections'

// Why: matches desktop's PR_GROUP_META naming from worktree-list-groups.ts.
// no PR/draft/unknown -> "In Progress", open -> "In Review", merged -> "Done", closed -> "Closed"
export type PRGroupKey = 'done' | 'in-review' | 'in-progress' | 'closed'

export const PR_GROUP_LABELS: Record<PRGroupKey, string> = {
  done: 'Done',
  'in-review': 'In Review',
  'in-progress': 'In Progress',
  closed: 'Closed'
}

export const PR_GROUP_ORDER: PRGroupKey[] = ['done', 'in-review', 'in-progress', 'closed']

export function getPRGroupKey(w: Worktree): PRGroupKey {
  if (!w.linkedPR) {
    return 'in-progress'
  }
  const s = w.linkedPR.state.toLowerCase()
  if (s === 'merged') {
    return 'done'
  }
  if (s === 'closed') {
    return 'closed'
  }
  if (s === 'draft') {
    return 'in-progress'
  }
  return 'in-review'
}
