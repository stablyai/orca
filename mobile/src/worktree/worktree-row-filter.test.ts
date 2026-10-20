import { NO_WORKSPACE_ROW_FILTERS } from '../../../src/shared/workspace-view/workspace-row-filters'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Worktree } from './workspace-list-types'
import { filterWorktrees } from './worktree-row-filter'

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  const worktreePath = join('/tmp', 'orca', 'worktrees', 'feature')
  return {
    workspaceKind: 'git',
    worktreeId: `repo-1::${worktreePath}`,
    repoId: 'repo-1',
    repo: 'orca',
    branch: 'feature/mobile-parity',
    displayName: 'feature',
    path: worktreePath,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null,
    status: 'inactive',
    agents: [],
    ...overrides
  }
}

describe('filterWorktrees', () => {
  it('hides archived worktrees', () => {
    const visible = worktree({ worktreeId: 'visible' })
    const archived = worktree({ worktreeId: 'archived', isArchived: true })

    expect(filterWorktrees([visible, archived], { ...NO_WORKSPACE_ROW_FILTERS }, '')).toEqual([
      visible
    ])
  })

  it('uses host sidebar activity for sleeping filtering when available', () => {
    const visible = worktree({
      worktreeId: 'visible',
      status: 'inactive',
      liveTerminalCount: 0,
      hasHostSidebarActivity: true
    })
    const retainedPtyOnly = worktree({
      worktreeId: 'retained-pty-only',
      status: 'active',
      liveTerminalCount: 3,
      hasHostSidebarActivity: false
    })

    expect(
      filterWorktrees(
        [visible, retainedPtyOnly],
        { ...NO_WORKSPACE_ROW_FILTERS, hideSleepingWorkspaces: true },
        ''
      )
    ).toEqual([visible])
  })

  it('uses the host-provided main-worktree flag for default branch hiding', () => {
    const main = worktree({
      worktreeId: 'main',
      branch: 'main',
      isMainWorktree: true
    })
    const featureNamedMain = worktree({
      worktreeId: 'feature-main',
      branch: 'main',
      isMainWorktree: false
    })

    expect(
      filterWorktrees(
        [main, featureNamedMain],
        { ...NO_WORKSPACE_ROW_FILTERS, hideDefaultBranchWorkspace: true },
        ''
      )
    ).toEqual([featureNamedMain])
  })

  it('keeps a sleeping main worktree visible under hide-sleeping by default (#8873)', () => {
    const main = worktree({ worktreeId: 'main', branch: 'main', isMainWorktree: true })
    const feature = worktree({ worktreeId: 'feature', isMainWorktree: false })

    expect(
      filterWorktrees(
        [main, feature],
        { ...NO_WORKSPACE_ROW_FILTERS, hideSleepingWorkspaces: true },
        ''
      )
    ).toEqual([main])
  })

  it('keeps a sleeping folder workspace visible under hide-sleeping', () => {
    const folder = worktree({
      workspaceKind: 'folder-workspace',
      worktreeId: 'folder:workspace-1',
      branch: '',
      isMainWorktree: true
    })

    expect(
      filterWorktrees([folder], { ...NO_WORKSPACE_ROW_FILTERS, hideSleepingWorkspaces: true }, '')
    ).toEqual([folder])
  })

  it('re-hides the sleeping main worktree when the desktop setting is off', () => {
    const main = worktree({ worktreeId: 'main', branch: 'main', isMainWorktree: true })

    expect(
      filterWorktrees(
        [main],
        {
          ...NO_WORKSPACE_ROW_FILTERS,
          hideSleepingWorkspaces: true,
          alwaysShowDefaultBranchWorkspace: false
        },
        ''
      )
    ).toEqual([])
  })

  it('falls back to the branch heuristic for hosts that omit isMainWorktree', () => {
    const legacyMain = worktree({ worktreeId: 'legacy-main', branch: 'refs/heads/master' })

    expect(
      filterWorktrees(
        [legacyMain],
        { ...NO_WORKSPACE_ROW_FILTERS, hideSleepingWorkspaces: true },
        ''
      )
    ).toEqual([legacyMain])
  })

  it('keeps a sleeping folder workspace on hosts that omit isMainWorktree', () => {
    // A folder workspace has no branch, so the legacy branch heuristic can never
    // recognise it — without its own arm, #8873 still reproduces on old desktops.
    const legacyFolder = worktree({
      workspaceKind: 'folder-workspace',
      worktreeId: 'folder:legacy-1',
      branch: ''
    })

    expect(
      filterWorktrees(
        [legacyFolder],
        { ...NO_WORKSPACE_ROW_FILTERS, hideSleepingWorkspaces: true },
        ''
      )
    ).toEqual([legacyFolder])
  })

  it('lets hide-default-branch still win over the sleeping exemption', () => {
    const main = worktree({ worktreeId: 'main', branch: 'main', isMainWorktree: true })

    expect(
      filterWorktrees(
        [main],
        {
          ...NO_WORKSPACE_ROW_FILTERS,
          hideSleepingWorkspaces: true,
          hideDefaultBranchWorkspace: true
        },
        ''
      )
    ).toEqual([])
  })

  it('keeps folder workspaces when default branch hiding is enabled', () => {
    const folder = worktree({
      workspaceKind: 'folder-workspace',
      worktreeId: 'folder:workspace-1',
      branch: '',
      isMainWorktree: true
    })

    expect(
      filterWorktrees(
        [folder],
        { ...NO_WORKSPACE_ROW_FILTERS, hideDefaultBranchWorkspace: true },
        ''
      )
    ).toEqual([folder])
  })

  it("drops other-client rows only while the desktop's Hide other-client workspaces is on", () => {
    const mine = worktree({ worktreeId: 'mine' })
    const other = worktree({ worktreeId: 'other', desktopOtherClient: true })
    const hiding = { ...NO_WORKSPACE_ROW_FILTERS, hideWorkspacesFromOtherDevices: true }

    expect(filterWorktrees([mine, other], hiding, '')).toEqual([mine])
    expect(filterWorktrees([mine, other], NO_WORKSPACE_ROW_FILTERS, '')).toEqual([mine, other])
  })
})
