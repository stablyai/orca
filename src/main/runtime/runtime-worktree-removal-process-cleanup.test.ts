/**
 * The runtime's removal (CLI `worktree rm`, paired clients, headless) drops the same per-id process
 * state and persisted scan snapshots as the desktop IPC removal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  unregisterWorktree: vi.fn(),
  pruneCleanupScan: vi.fn(async () => {}),
  pruneSpaceAnalysis: vi.fn(async () => {})
}))

vi.mock('../localhost-worktree-label-proxy', () => ({
  localhostWorktreeLabelProxy: { unregisterWorktree: mocks.unregisterWorktree }
}))
vi.mock('../workspace-cleanup-scan-snapshot', () => ({
  pruneWorkspaceCleanupScanSnapshot: mocks.pruneCleanupScan
}))
vi.mock('../workspace-space-analysis-snapshot', () => ({
  pruneWorkspaceSpaceAnalysisSnapshot: mocks.pruneSpaceAnalysis
}))

import type { Repo } from '../../shared/repo-types'
import { OrcaRuntimeService } from './orca-runtime'

const WT = 'repo-1::/tmp/worktree-a'

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1,
    ...overrides
  }
}

function createRuntime(repos: Repo[]) {
  const store = {
    getRepo: () => repos[0],
    getRepos: () => repos,
    addRepo: () => {},
    updateRepo: () => undefined,
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    removeWorktreeMeta: () => {},
    getGitHubCache: () => ({ pr: {}, issue: {} }),
    setWorktreeMeta: () => undefined,
    getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
    addRetiredWorktreeName: () => {},
    mergeRetiredWorktreeNames: () => false,
    getProfileStorageDirectory: () => '/tmp/profile',
    getSettings: () => ({
      workspaceDir: '/tmp/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial store covering every method this removal path reads.
  const runtimeStore = store as never
  return { runtime: new OrcaRuntimeService(runtimeStore), store: runtimeStore }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runtime worktree removal cleanup', () => {
  it('drops label routes and persisted scan snapshots', () => {
    const { runtime, store } = createRuntime([repo()])

    runtime.removeWorktreeMetadataAndHistory(store, WT, 'local')

    expect(mocks.unregisterWorktree).toHaveBeenCalledWith(WT)
    expect(mocks.pruneCleanupScan).toHaveBeenCalledWith('/tmp/profile', WT, 'local')
    expect(mocks.pruneSpaceAnalysis).toHaveBeenCalledWith('/tmp/profile', WT, 'local')
  })

  it('keeps a surviving same-id twin its process state but prunes only this host snapshot', () => {
    const { runtime, store } = createRuntime([repo(), repo({ connectionId: 'box' })])

    runtime.removeWorktreeMetadataAndHistory(store, WT, 'local')

    expect(mocks.unregisterWorktree).not.toHaveBeenCalled()
    expect(mocks.pruneCleanupScan).toHaveBeenCalledWith('/tmp/profile', WT, 'local')
  })
})
