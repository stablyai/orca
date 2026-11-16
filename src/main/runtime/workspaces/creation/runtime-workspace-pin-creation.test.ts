import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import { createWorktreeCreateTimingRecorder } from '../../../workspaces/creation/worktree-create-timing'
import { materializeRuntimeLocalWorktree } from './runtime-local-worktree-materialization'
import { createRuntimeFolderWorktree } from './runtime-folder-worktree-create'

vi.mock('../../../git/worktrees/content-paths/worktree-include-file', () => ({
  resolveWorktreeIncludePaths: vi.fn().mockResolvedValue([])
}))
vi.mock('../../../git/worktrees/content-paths/worktree-shared-directories', () => ({
  resolveWorktreeSharedDirectories: vi.fn().mockResolvedValue([])
}))

const repo: Repo = { id: 'repo', path: '/repo', displayName: 'Repo', badgeColor: '', addedAt: 0 }
const automation: NonNullable<RuntimeManagedWorktreeCreateArgs['automationProvenance']> = {
  kind: 'created-by-automation',
  automationId: 'a',
  automationNameSnapshot: 'A',
  automationRunId: 'r',
  automationRunTitleSnapshot: 'R',
  createdAt: 1,
  executionTargetType: 'local',
  executionTargetId: 'local',
  projectId: 'repo'
}
const cases: [string, Partial<RuntimeManagedWorktreeCreateArgs>, boolean][] = [
  ['default', {}, false],
  ['UI opt-in', { pinOnCreate: true }, true],
  ['CLI', { pinOnCreate: true, cliProvenance: { kind: 'created-by-cli', createdAt: 1 } }, false],
  ['automation', { pinOnCreate: true, automationProvenance: automation }, false]
]

describe.each(cases)('workspace pin on create: %s', (_label, overrides, expected) => {
  it('persists git metadata before publishing the created worktree', async () => {
    let persisted: Partial<WorktreeMeta> = {}
    const store = {
      setWorktreeMeta: (_target: unknown, updates: Partial<WorktreeMeta>) => {
        persisted = updates
        return updates
      }
    }
    const result = await materializeRuntimeLocalWorktree({
      request: { repoSelector: 'repo', name: 'work', ...overrides },
      repo,
      // SAFETY: this test exercises the metadata write; other store services are unused.
      store: store as never,
      settings: { workspaceDir: '/workspaces', nestWorkspaces: false },
      created: {
        path: '/workspaces/work',
        head: 'abc',
        branch: 'refs/heads/work',
        isBare: false,
        isMainWorktree: false
      },
      remoteTrackingBase: null,
      sparseDirectories: [],
      checkoutExistingBranch: false,
      baseBranch: 'main',
      branchName: 'work',
      effectiveRequestedName: 'work',
      displayNameKind: undefined,
      effectiveSanitizedName: 'work',
      localWorktreeGitOptions: {},
      onMetadataPersisted: (worktree) => ({
        pinAtNotification: worktree.isPinned,
        pinInStore: persisted.isPinned ?? false
      }),
      timing: createWorktreeCreateTimingRecorder()
    })
    expect(result.metadataResult).toEqual({ pinAtNotification: expected, pinInStore: expected })
  })

  it('persists folder metadata before publishing the created workspace', async () => {
    let persisted: Partial<WorktreeMeta> = {}
    let pinAtNotification: boolean | undefined
    const store = {
      getSettings: () => ({ workspaceDir: '/workspaces', nestWorkspaces: false }),
      setWorktreeMeta: (_target: unknown, updates: Partial<WorktreeMeta>) => {
        persisted = updates
        return updates
      }
    }
    const result = await createRuntimeFolderWorktree({
      request: { repoSelector: 'repo', name: 'work', ...overrides },
      repo,
      deps: {
        // SAFETY: the test supplies the store and terminal members this create path uses.
        store: store as never,
        terminals: { canSpawn: false } as never,
        invalidateResolvedWorktrees: () => {},
        notifyWorktreesChanged: () => {},
        emitCreated: () => {
          pinAtNotification = persisted.isPinned ?? false
        },
        activate: () => {}
      }
    })
    expect({ pinAtNotification, pinInResult: result.worktree.isPinned }).toEqual({
      pinAtNotification: expected,
      pinInResult: expected
    })
  })
})
