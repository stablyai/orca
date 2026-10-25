import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../src/shared/repo-types'
import {
  filterWorkspaceRows,
  type WorkspaceRowFactReader,
  type WorkspaceRowFilters
} from '../../../src/shared/workspace-view/workspace-row-filters'
import {
  getWorkspaceRowKindFacts,
  isAutomationGeneratedWorkspace,
  isCliCreatedWorkspace,
  isDefaultBranchWorkspace,
  isDetachedHeadWorkspace
} from '../../../src/shared/worktree/workspace-kinds'
import type { Worktree as DesktopWorktree } from '../../../src/shared/worktree/types'
import { filterWorktrees, type Worktree } from './workspace-list-sections'

// The phone's list against the desktop sidebar's for the same workspaces, under every filter
// combination. The desktop side mirrors desktop-workspace-row-facts.ts, which mobile tests cannot
// import (renderer aliases); the phone side reads only what a host stamps on worktree.ps rows.

const repos: Repo[] = [
  { id: 'git', path: '/git', displayName: 'Git', badgeColor: '#000', addedAt: 0 },
  {
    id: 'folder-repo',
    path: '/f',
    displayName: 'Folder',
    badgeColor: '#000',
    addedAt: 0,
    kind: 'folder'
  }
]
const repoMap = new Map(repos.map((repo) => [repo.id, repo]))

type Fixture = DesktopWorktree & { sleeping: boolean; otherClient: boolean; folderWorkspace?: true }

function fixture(id: string, fields: Partial<Fixture> = {}): Fixture {
  return {
    id,
    repoId: 'git',
    path: `/w/${id}`,
    head: 'abc1234',
    branch: `refs/heads/${id}`,
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    sleeping: true,
    otherClient: false,
    ...fields
  }
}

const FIXTURES: Fixture[] = [
  fixture('main', { isMainWorktree: true, branch: 'refs/heads/main' }),
  fixture('main-detached', { isMainWorktree: true, branch: '' }),
  fixture('provisioned', { isMainWorktree: true, ephemeralVmCheckoutMode: 'provisioned-root' }),
  fixture('awake', { sleeping: false }),
  fixture('automation', {
    sleeping: false,
    automationProvenance: {
      kind: 'created-by-automation',
      automationId: 'a',
      automationNameSnapshot: 'Nightly',
      automationRunId: 'r',
      automationRunTitleSnapshot: 'Run',
      createdAt: 0,
      executionTargetType: 'local',
      executionTargetId: 'local',
      projectId: 'p',
      hostId: 'local'
    }
  }),
  fixture('cli', { sleeping: false, cliProvenance: { kind: 'created-by-cli', createdAt: 0 } }),
  fixture('detached', { branch: '', sleeping: false }),
  fixture('other-client', { otherClient: true, sleeping: false }),
  fixture('archived', { isArchived: true, sleeping: false }),
  fixture('folder-root', { repoId: 'folder-repo', isMainWorktree: true, branch: '', head: '' }),
  fixture('folder:lane', {
    repoId: 'folder-workspace:group',
    branch: '',
    head: '',
    folderWorkspace: true
  })
]

const DESKTOP_FACTS: WorkspaceRowFactReader<Fixture> = {
  isArchived: (w) => w.isArchived,
  isFolderWorkspace: (w) => w.folderWorkspace === true,
  repoId: (w) => w.repoId,
  hostId: () => 'local',
  isOtherClient: (w) => w.otherClient,
  isDefaultBranch: (w) => isDefaultBranchWorkspace(w, repoMap.get(w.repoId)),
  isAutomationCreated: isAutomationGeneratedWorkspace,
  isCliCreated: isCliCreatedWorkspace,
  isDetachedHead: isDetachedHeadWorkspace,
  isMainWorktree: (w) => w.isMainWorktree,
  isSleeping: (w) => w.sleeping
}

/** The row the phone receives for this workspace from a current host. */
function served(w: Fixture): Worktree {
  return {
    workspaceKind: w.folderWorkspace ? 'folder-workspace' : 'git',
    worktreeId: w.id,
    repoId: w.repoId,
    hostId: 'local',
    repo: repoMap.get(w.repoId)?.displayName ?? w.repoId,
    branch: w.branch,
    displayName: w.displayName,
    path: w.path,
    isArchived: w.isArchived,
    isMainWorktree: w.isMainWorktree,
    hasHostSidebarActivity: !w.sleeping,
    ...(w.otherClient ? { desktopOtherClient: true } : {}),
    ...getWorkspaceRowKindFacts(w, repoMap.get(w.repoId)),
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null
  }
}

function* everyFilterCombination(): Generator<Omit<WorkspaceRowFilters, 'visibleHostIds'>> {
  const bools = [false, true]
  for (const hideSleepingWorkspaces of bools) {
    for (const alwaysShowDefaultBranchWorkspace of [undefined, true, false]) {
      for (const hideDefaultBranchWorkspace of bools) {
        for (const hideAutomationGeneratedWorkspaces of bools) {
          for (const hideCliCreatedWorkspaces of bools) {
            for (const hideDetachedHeadWorkspaces of bools) {
              for (const hideWorkspacesFromOtherDevices of bools) {
                for (const filterRepoIds of [[], ['git'], ['folder-repo']]) {
                  yield {
                    hideSleepingWorkspaces,
                    alwaysShowDefaultBranchWorkspace,
                    hideDefaultBranchWorkspace,
                    hideAutomationGeneratedWorkspaces,
                    hideCliCreatedWorkspaces,
                    hideDetachedHeadWorkspaces,
                    hideWorkspacesFromOtherDevices,
                    filterRepoIds
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

describe('the phone shows what the desktop sidebar shows', () => {
  it('under every Workspace options filter combination, folder projects included', () => {
    const phoneRows = FIXTURES.map(served)
    let combinations = 0
    for (const filters of everyFilterCombination()) {
      combinations += 1
      const desktop = filterWorkspaceRows(
        FIXTURES,
        { ...filters, visibleHostIds: null },
        DESKTOP_FACTS
      )
      const phone = filterWorktrees(phoneRows, { ...filters, visibleHostIds: null }, '')
      expect(
        phone.map((w) => w.worktreeId),
        JSON.stringify(filters)
      ).toEqual(desktop.map((w) => w.id))
    }
    expect(combinations).toBe(2 * 3 * 2 ** 5 * 3)
  })

  it('keeps every row an older host sends, whatever kind filter is on', () => {
    const legacy: Worktree[] = FIXTURES.filter((w) => !w.isArchived && !w.otherClient).map((w) => ({
      worktreeId: w.id,
      repoId: w.repoId,
      repo: w.repoId,
      branch: w.branch,
      displayName: w.displayName,
      path: w.path,
      liveTerminalCount: 1,
      hasAttachedPty: false,
      unread: false,
      isPinned: false,
      linkedPR: null
    }))
    const kindFiltersOn = {
      hideSleepingWorkspaces: false,
      hideDefaultBranchWorkspace: false,
      hideAutomationGeneratedWorkspaces: true,
      hideCliCreatedWorkspaces: true,
      hideDetachedHeadWorkspaces: true,
      hideWorkspacesFromOtherDevices: true,
      filterRepoIds: [],
      visibleHostIds: null
    }
    expect(filterWorktrees(legacy, kindFiltersOn, '')).toHaveLength(legacy.length)
  })
})
