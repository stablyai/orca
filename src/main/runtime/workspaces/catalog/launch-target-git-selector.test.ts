// The Items read's shared worktree reads apply only through this selector: a bare worker id must reach it.
import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/workspace/identity/floating-workspace-id'
import { launchTargetGitSelector } from './launch-target-git-selector'

describe('launchTargetGitSelector', () => {
  it('passes worktree ids to the Git lookup and leaves folders and the floating workspace out', () => {
    expect(launchTargetGitSelector('id:repo-1::/work/app-wt/one')).toBe(
      'id:repo-1::/work/app-wt/one'
    )
    expect(launchTargetGitSelector('id:worktree:repo-1::/work/app-wt/one')).toBe(
      'id:repo-1::/work/app-wt/one'
    )
    expect(launchTargetGitSelector('id:folder:f-1')).toBeNull()
    expect(launchTargetGitSelector(`id:${FLOATING_TERMINAL_WORKTREE_ID}`)).toBeNull()
  })
})
