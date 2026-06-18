import { describe, expect, it } from 'vitest'
import { buildWorkspaceSessionPath, openWorkspaceSession } from './workspace-open-action'

const item = {
  worktreeId: 'repo::/Users/me/orca/workspaces/feature branch',
  displayName: 'Feature Branch',
  repo: 'orca'
}

describe('workspace open action', () => {
  it('builds the mobile session target for a workspace row', () => {
    expect(buildWorkspaceSessionPath('host-1', item)).toBe(
      '/h/host-1/session/repo%3A%3A%2FUsers%2Fme%2Forca%2Fworkspaces%2Ffeature%20branch?name=Feature%20Branch'
    )
  })

  it('navigates before activation bookkeeping', () => {
    const events: string[] = []

    openWorkspaceSession('host-1', item, {
      navigate: (target) => {
        events.push(`navigate:${target}`)
        return true
      },
      markOptimisticActive: (worktreeId) => events.push(`active:${worktreeId}`),
      activateWorktree: (worktreeId) => events.push(`activate:${worktreeId}`)
    })

    expect(events).toEqual([
      `navigate:${buildWorkspaceSessionPath('host-1', item)}`,
      `active:${item.worktreeId}`,
      `activate:${item.worktreeId}`
    ])
  })
})
