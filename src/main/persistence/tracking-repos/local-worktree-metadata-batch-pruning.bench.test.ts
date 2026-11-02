// Opt in: ORCA_LOCAL_METADATA_PRUNE_BENCH=1 pnpm test src/main/persistence/tracking-repos/local-worktree-metadata-batch-pruning.bench.test.ts
import { performance } from 'node:perf_hooks'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Repo } from '../../../shared/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { removeWorkspaceSessionOwner } from '../restoring-sessions/session-owner-removal'
import {
  pruneUnreferencedWorktreeIdentityMeta,
  removeWorktreeMetadataForHost
} from '../loading-store/worktree-identity-metadata'
import {
  captureNativeLocalWorktreeMetadataScanExpectation,
  pruneSessionlessMissingLocalWorktreeMetadataForRepo
} from './missing-local-worktree-metadata-pruning'

const describeBench = process.env.ORCA_LOCAL_METADATA_PRUNE_BENCH ? describe : describe.skip
const ROW_COUNT = 2_709
const REPO: Repo = {
  id: 'repo-1',
  path: '/workspace/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
}

function makeMeta(index: number): WorktreeMeta {
  return {
    instanceId: `instance-${index}`,
    hostId: 'local',
    displayName: `stale-${index}`,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: index,
    lastActivityAt: 0
  }
}

function makeState(): { state: PersistedState; staleIds: string[] } {
  const state = getDefaultPersistedState('/home/test')
  state.repos = [REPO]
  state.worktreeMetaByIdentity = {}
  state.worktreeIdentityAliases = {}
  const staleIds = Array.from(
    { length: ROW_COUNT },
    (_, index) => `${REPO.id}::/workspace/stale-${index}`
  )
  for (const [index, worktreeId] of staleIds.entries()) {
    const meta = makeMeta(index)
    const identityKey = `identity-${index}`
    state.worktreeMeta[worktreeId] = meta
    state.worktreeMetaByIdentity[identityKey] = meta
    state.worktreeIdentityAliases[`local|${worktreeId}`] = [identityKey]
  }
  return { state, staleIds }
}

describeBench('authoritative local metadata batch pruning', () => {
  it('measures the reported 2,709-row sequential and batch shapes', () => {
    const legacy = makeState()
    const batch = makeState()
    const cloneSpy = vi.spyOn(globalThis, 'structuredClone')
    const legacyStartedAt = performance.now()
    for (const worktreeId of legacy.staleIds) {
      removeWorktreeMetadataForHost(legacy.state, worktreeId, undefined)
      delete legacy.state.worktreeMeta[worktreeId]
      legacy.state.workspaceSession = removeWorkspaceSessionOwner(
        legacy.state.workspaceSession,
        worktreeId
      )!
    }
    pruneUnreferencedWorktreeIdentityMeta(legacy.state)
    const legacyMs = performance.now() - legacyStartedAt
    const legacySessionClones = cloneSpy.mock.calls.length
    cloneSpy.mockClear()

    const batchStartedAt = performance.now()
    const scan = captureNativeLocalWorktreeMetadataScanExpectation(batch.state, REPO)
    const removed = pruneSessionlessMissingLocalWorktreeMetadataForRepo(
      batch.state,
      scan,
      scan.metadata
    )
    const batchMs = performance.now() - batchStartedAt
    const batchSessionClones = cloneSpy.mock.calls.length
    cloneSpy.mockRestore()

    expect(removed).toHaveLength(ROW_COUNT)
    expect(Object.keys(legacy.state.worktreeMeta)).toHaveLength(0)
    expect(Object.keys(batch.state.worktreeMeta)).toHaveLength(0)
    expect(legacySessionClones).toBe(ROW_COUNT)
    expect(batchSessionClones).toBe(0)

    console.log(
      `[bench] rows=${ROW_COUNT} metadata+session=${legacyMs.toFixed(2)}ms -> ${batchMs.toFixed(2)}ms; ` +
        `gitScans=${ROW_COUNT} -> 1; sessionClones=${legacySessionClones} -> ${batchSessionClones}; ` +
        `minimumSaveSchedules=${ROW_COUNT * 2} -> 1`
    )
  })
})
