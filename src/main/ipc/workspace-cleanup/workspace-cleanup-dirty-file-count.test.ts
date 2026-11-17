import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../shared/git/status/git-status-types'
import { countWorkspaceCleanupDirtyFiles } from './workspace-cleanup-git-evidence'

const entry = (path: string, area: GitStatusEntry['area']): GitStatusEntry => ({
  path,
  area,
  status: 'modified'
})

describe('countWorkspaceCleanupDirtyFiles', () => {
  it('counts a partly staged file once', () => {
    expect(
      countWorkspaceCleanupDirtyFiles({
        entries: [entry('a.ts', 'staged'), entry('a.ts', 'unstaged'), entry('b.ts', 'untracked')]
      })
    ).toBe(2)
  })

  it('reports no total once the status read was capped', () => {
    expect(
      countWorkspaceCleanupDirtyFiles({ entries: [entry('a.ts', 'staged')], didHitLimit: true })
    ).toBeNull()
  })
})
