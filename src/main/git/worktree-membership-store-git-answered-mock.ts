import { readTranslatedWorktreeGraph } from './worktree-list-reader'
import type * as MembershipStore from './worktree-membership/worktree-membership-store'

// Why: suites that pin Git-level listing behaviour (porcelain forms, capability probes, removal
// lookups) mock Git with made-up paths the model cannot stat, so their reads take the path the
// model keeps for layouts it cannot read from files: Git answers directly.
export const gitAnsweredMembershipStoreMock = (
  original: typeof MembershipStore
): typeof MembershipStore => ({
  ...original,
  readWorktreeMembership: async (repoPath, options = {}) => ({
    rows: await readTranslatedWorktreeGraph(repoPath, options),
    fromModel: false
  })
})
