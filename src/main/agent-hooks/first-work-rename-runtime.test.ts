import { describe, expect, it } from 'vitest'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { firstWorkRenameDeps } from './first-work-rename-runtime'

function depsFor(meta: Partial<WorktreeMeta>) {
  return firstWorkRenameDeps({ getWorktreeMeta: () => meta } as never, {} as never)
}

describe('first-work branch rename eligibility', () => {
  it('never renames a branch the user switched to or created in Orca', () => {
    const created: Partial<WorktreeMeta> = { orcaCreationSource: 'desktop' }

    expect(depsFor(created).canRenameOrcaCreatedBranch('repo::/w')).toBe(true)
    expect(
      depsFor({ ...created, branchNameIsUserChosen: true }).canRenameOrcaCreatedBranch('repo::/w')
    ).toBe(false)
  })
})
