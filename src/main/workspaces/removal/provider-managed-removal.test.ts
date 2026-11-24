import { describe, expect, it } from 'vitest'
import type { PersistedState } from '../../../shared/orca-profiles/persisted-state-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { ResolvedWorkspaceCleanupPolicy } from '../../../shared/workspace-cleanup/workspace-cleanup-policy'
import {
  canQueueWorkspaceCleanupCandidate,
  type WorkspaceCleanupBlocker
} from '../../../shared/workspace-cleanup/workspace-cleanup'
import { evaluateWorkspaceCleanup } from '../../../shared/workspace-cleanup/workspace-cleanup-evaluation'
import { isLocallyRemovableWorktreeMetadataRow } from '../../persistence/tracking-repos/local-worktree-metadata-scan-expectation'
import { gcStaleWorktreeMeta } from '../../persistence/tracking-repos/worktree-metadata-normalization'
import { makeRepo } from '../../persistence/persistence-test-harness'
import { canCleanupUnregisteredOrcaWorktreeDirectory } from './worktree-removal-safety'
import {
  assertWorktreeNotProviderManaged,
  WORKTREE_PROVIDER_MANAGED_CODE
} from './provider-worktree-removal-guard'

const NOW = 1_000_000

const PROVIDER = {
  name: 'wtp',
  leaseId: 'lease-1',
  handle: { token: 'abc' },
  timeoutSeconds: 300,
  acquiredAt: 1000
}

const META: WorktreeMeta = {
  displayName: 'slot',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  worktreeProvider: PROVIDER
}

describe('provider-managed removal protection', () => {
  it('refuses a provider-managed workspace with an actionable code', () => {
    expect(() => assertWorktreeNotProviderManaged('repo-1::/slot', META)).toThrowError(
      expect.objectContaining({ code: WORKTREE_PROVIDER_MANAGED_CODE })
    )
  })

  it('never authorizes deleting an unregistered provider checkout', () => {
    expect(canCleanupUnregisteredOrcaWorktreeDirectory({ meta: META })).toBe(false)
  })

  it('never prunes provider metadata when its path disappears', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the three persisted maps read by the helper are needed.
    const state = {
      worktreeMeta: { 'repo-1::/slot': META },
      worktreeIdentityAliases: {},
      worktreeMetaByIdentity: {}
    } as unknown as PersistedState
    expect(isLocallyRemovableWorktreeMetadataRow(state, 'repo-1::/slot', [])).toBe(false)

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the GC only reads the persisted maps and repo rows supplied here.
    const gcState = {
      worktreeMeta: { 'repo-1::/slot': { ...META, hostId: 'local' } },
      worktreeLineageById: {},
      workspaceLineageByChildKey: {},
      worktreeIdentityAliases: {},
      worktreeMetaByIdentity: {},
      repos: [
        makeRepo({ id: 'repo-1', path: '/repo', executionHostId: 'local', connectionId: undefined })
      ],
      projects: []
    } as unknown as PersistedState
    expect(gcStaleWorktreeMeta(gcState)).toBe(0)
    expect(gcState.worktreeMeta['repo-1::/slot']).toBeDefined()
  })

  it('keeps provider workspaces out of cleanup previews and bulk selection', () => {
    const blockers: WorkspaceCleanupBlocker[] = ['provider-managed']
    expect(canQueueWorkspaceCleanupCandidate({ blockers })).toBe(false)
    expect(
      evaluateWorkspaceCleanup(
        {
          reasons: ['inactive'],
          blockers,
          lastActivityAt: 0,
          git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: 1 }
        },
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the blocker short-circuits before any policy field is read.
        {} as ResolvedWorkspaceCleanupPolicy,
        NOW
      )
    ).toEqual({ action: 'keep', cause: 'not-removable' })
  })
})
