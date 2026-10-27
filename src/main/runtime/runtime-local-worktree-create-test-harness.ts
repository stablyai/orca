import { expect, vi, type Mock } from 'vitest'
import { resolve } from 'node:path'
import type { Store } from '../persistence'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { HostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import type { Repo } from '../../shared/repo-types'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import { resolveGitAdmissionTier } from '../git/command-runner/git-operation-executor'
import type { PreparationRearmHolder } from '../worktree-create-preparation'
import {
  createWorktreeCreateTimingRecorder,
  type WorktreeCreateTimingRecorder
} from '../worktree-create-timing'
import type { SparsePreset } from '../../shared/worktree/create-types'

type RuntimeCreateMocks = {
  git: Mock
  rearm: Mock
  routing: Mock<() => { wslDistro?: string }>
  defaultBase: Mock
  hasBase: Mock
  branchName: Mock
  canCheckout: Mock
  pathExists: Mock
  branchConflict: Mock
  githubPr: Mock
  consume: Mock
  add: Mock
  addSparse: Mock
  pushTarget: Mock
  listing: Mock
  remoteBase: Mock
  hasRemoteRef: Mock
  refresh: Mock
  fetch: Mock
  resolveShared: Mock<() => Promise<string[]>>
  resolveInclude: Mock<() => Promise<string[]>>
  copyPaths: Mock<() => Promise<string[]>>
  effectiveHooks: Mock
  created: {
    path: string
    head: string
    branch: string
    isBare: boolean
    isMainWorktree: boolean
  }
}

export const runtimeCreateMocks: RuntimeCreateMocks = {
  git: vi.fn(),
  rearm: vi.fn(),
  routing: vi.fn<() => { wslDistro?: string }>(),
  defaultBase: vi.fn(),
  hasBase: vi.fn(),
  branchName: vi.fn(),
  canCheckout: vi.fn(),
  pathExists: vi.fn(),
  branchConflict: vi.fn(),
  githubPr: vi.fn(),
  consume: vi.fn(),
  add: vi.fn(),
  addSparse: vi.fn(),
  pushTarget: vi.fn(),
  listing: vi.fn(),
  remoteBase: vi.fn(),
  hasRemoteRef: vi.fn(),
  refresh: vi.fn(),
  fetch: vi.fn(),
  resolveShared: vi.fn<() => Promise<string[]>>(),
  resolveInclude: vi.fn<() => Promise<string[]>>(),
  copyPaths: vi.fn<() => Promise<string[]>>(),
  effectiveHooks: vi.fn(),
  created: {
    path: '',
    head: 'abc123',
    branch: 'app',
    isBare: false,
    isMainWorktree: false
  }
}

export const worktreePath = resolve('/worktrees', 'app')

export const pickedBranch = {
  baseBranch: 'origin/main',
  branchNameOverride: 'main',
  branchIntent: 'open-existing'
} as const

export const writtenMeta: Partial<WorktreeMeta>[] = []
const WEB_PRESET: SparsePreset = {
  id: 'preset-web',
  repoId: 'repo-1',
  name: 'web',
  directories: ['apps/web', 'packages/ui'],
  createdAt: 0,
  updatedAt: 0
}
export const readSparsePresets = vi.fn<(repoId: string) => SparsePreset[]>()

export async function createWorktree(
  request: Partial<RuntimeManagedWorktreeCreateArgs> = {},
  rearm: PreparationRearmHolder = { fire: () => {} },
  timing: WorktreeCreateTimingRecorder = createWorktreeCreateTimingRecorder(),
  repoOverrides: Partial<Repo> = {},
  autoRenameBranchFromWork = false
) {
  const store = {
    getSettings: () => ({
      workspaceDir: '/worktrees',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: '',
      autoRenameBranchFromWork
    }),
    setWorktreeMeta: (_target: HostWorktreeTarget, updates: Partial<WorktreeMeta>) => {
      writtenMeta.push(updates)
      return updates
    },
    getSparsePresets: (repoId: string): SparsePreset[] => readSparsePresets(repoId)
  }
  // Loaded on call so module mock factories can import this harness without a cycle.
  const { createRuntimeLocalManagedWorktree } = await import('./runtime-local-worktree-create')
  return createRuntimeLocalManagedWorktree({
    request: { repoSelector: 'repo-1', name: 'app', baseBranch: 'main', ...request },
    repo: {
      id: 'repo-1',
      path: '/repo',
      displayName: 'Repo',
      badgeColor: '#000000',
      addedAt: 0,
      ...repoOverrides
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: All store methods reached by this isolated create path are supplied above.
    store: store as Store,
    createdWithAgent: undefined,
    resolveRemoteTrackingBase: runtimeCreateMocks.remoteBase,
    hasRemoteTrackingRef: runtimeCreateMocks.hasRemoteRef,
    // vi.fn marks returned promises handled; a fresh promise exposes unawaited fetch rejection.
    refreshRemoteTrackingBase: async (...refreshArgs) =>
      await runtimeCreateMocks.refresh(...refreshArgs),
    fetchRemote: async (...fetchArgs) => await runtimeCreateMocks.fetch(...fetchArgs),
    onWorktreeMetadataPersisted: () => undefined,
    rearm,
    timing
  })
}

export function resetRuntimeCreateMocks(): void {
  vi.resetAllMocks()
  writtenMeta.length = 0
  runtimeCreateMocks.created.branch = 'app'
  runtimeCreateMocks.git.mockResolvedValue({ stdout: '', stderr: '' })
  runtimeCreateMocks.created.path = worktreePath
  runtimeCreateMocks.routing.mockReturnValue({})
  runtimeCreateMocks.defaultBase.mockImplementation(async () => {
    expect(resolveGitAdmissionTier()).toBe('interactive')
    return 'main'
  })
  runtimeCreateMocks.hasBase.mockResolvedValue(true)
  runtimeCreateMocks.branchName.mockResolvedValue('app')
  runtimeCreateMocks.canCheckout.mockResolvedValue(false)
  runtimeCreateMocks.pathExists.mockResolvedValue(false)
  runtimeCreateMocks.branchConflict.mockResolvedValue(null)
  runtimeCreateMocks.githubPr.mockResolvedValue(null)
  runtimeCreateMocks.consume.mockResolvedValue({
    status: 'hit',
    result: {},
    rearm: runtimeCreateMocks.rearm
  })
  runtimeCreateMocks.add.mockResolvedValue({})
  runtimeCreateMocks.addSparse.mockResolvedValue({})
  runtimeCreateMocks.listing.mockImplementation(async () => {
    expect(resolveGitAdmissionTier()).toBe('interactive')
    return { created: runtimeCreateMocks.created }
  })
  runtimeCreateMocks.remoteBase.mockImplementation(async () => {
    expect(resolveGitAdmissionTier()).toBe('interactive')
    return null
  })
  runtimeCreateMocks.hasRemoteRef.mockResolvedValue(true)
  runtimeCreateMocks.refresh.mockResolvedValue({ ok: true })
  runtimeCreateMocks.fetch.mockResolvedValue(undefined)
  runtimeCreateMocks.resolveShared.mockResolvedValue([])
  runtimeCreateMocks.resolveInclude.mockResolvedValue(['.env'])
  runtimeCreateMocks.copyPaths.mockResolvedValue([])
  runtimeCreateMocks.effectiveHooks.mockReturnValue(null)
  readSparsePresets.mockReturnValue([WEB_PRESET])
}
