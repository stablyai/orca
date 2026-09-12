import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OrcadMigrationCatalogState } from '../shared/orcad-migration-manifest'
import { worktreeWorkspaceKey } from '../shared/workspace-scope'
import { createStore, testState } from './persistence-test-harness'
import {
  setupSource,
  addDormantAutomation,
  commitDestination,
  receipt,
  TARGET
} from './orcad-migration-source-cutover-test-fixture'
import { retireOrcadMigrationSourceCatalogDurably } from './ssh/orcad-migration-cutover-coordinator'
import { createOrcadMigrationManifest } from './ssh/orcad-migration-manifest-export'

const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn(() => ({ nth_repo_added: 1 }))
}))

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

vi.mock('./telemetry/client', () => ({ track: trackMock }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-migration-source-cutover-'))
})

afterEach(() => {
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('orcad migration source cutover persistence', () => {
  it('durably fences the exact source before recording destination evidence', async () => {
    const { store, manifest } = setupSource()
    const cutover = store.beginOrcadMigrationSourceCutover(manifest, 'environment-1', {
      destinationName: 'Managed production',
      now: () => new Date('2026-08-30T12:01:00.000Z')
    })
    const replay = store.beginOrcadMigrationSourceCutover(manifest, 'environment-1', {
      destinationName: 'Managed production'
    })
    await store.flushPendingOrThrowAsync()

    const restored = createStore()
    expect(cutover.phase).toBe('source-fenced')
    expect(replay).toEqual(cutover)
    expect(store.listOrcadMigrationSourceCutovers()).toHaveLength(1)
    expect(restored.getSshTarget(TARGET.id)?.owner).toEqual({
      type: 'on-demand-runtime',
      runtimeId: 'managed-orcad:environment-1'
    })
    expect(restored.getOrcadMigrationSourceCutover(manifest.migrationId)).toMatchObject({
      phase: 'source-fenced',
      destinationName: 'Managed production',
      manifest: { manifestSha256: manifest.manifestSha256 }
    })
    expect(restored.getRepos().map((repo) => repo.id)).toEqual(['repo-1'])
  })

  it('accepts a display name when replaying a legacy nameless journal', () => {
    const { store, manifest } = setupSource()
    store.beginOrcadMigrationSourceCutover(manifest, 'environment-1')

    const replay = store.beginOrcadMigrationSourceCutover(manifest, 'environment-1', {
      destinationName: 'Managed production'
    })
    expect(replay.phase).toBe('source-fenced')
    expect(replay.destinationName).toBeUndefined()
  })

  it('rejects a different display name after the journal pins one', () => {
    const { store, manifest } = setupSource()
    store.beginOrcadMigrationSourceCutover(manifest, 'environment-1', {
      destinationName: 'Managed production'
    })

    expect(() =>
      store.beginOrcadMigrationSourceCutover(manifest, 'environment-1', {
        destinationName: 'Different name'
      })
    ).toThrow('orcad_migration_source_cutover_identity_conflict')
  })

  it('advances monotonically to an exact durable destination receipt', async () => {
    const { store, manifest } = setupSource()
    store.beginOrcadMigrationSourceCutover(manifest, 'environment-1')
    const staged: Extract<OrcadMigrationCatalogState, { state: 'staged' }> = {
      state: 'staged',
      migrationId: manifest.migrationId,
      manifestSha256: manifest.manifestSha256,
      stagedAt: '2026-08-30T12:02:00.000Z'
    }
    store.markOrcadMigrationDestinationStaged(manifest.migrationId, staged)
    await store.flushPendingOrThrowAsync()
    const stagedRestored = createStore()
    expect(stagedRestored.getOrcadMigrationSourceCutover(manifest.migrationId)).toMatchObject({
      phase: 'destination-staged',
      stagedAt: staged.stagedAt
    })
    const committed: Extract<OrcadMigrationCatalogState, { state: 'committed' }> = {
      state: 'committed',
      migrationId: manifest.migrationId,
      manifestSha256: manifest.manifestSha256,
      receipt: receipt(manifest)
    }
    stagedRestored.markOrcadMigrationDestinationCommitted(manifest.migrationId, committed)
    await stagedRestored.flushPendingOrThrowAsync()

    const restored = createStore()
    expect(restored.getOrcadMigrationSourceCutover(manifest.migrationId)).toMatchObject({
      phase: 'destination-committed',
      receipt: { importedAt: '2026-08-30T12:03:00.000Z' }
    })
    expect(() =>
      restored.releaseOrcadMigrationSourceCutover(manifest.migrationId, {
        kind: 'catalog-absent',
        state: {
          state: 'absent',
          migrationId: manifest.migrationId,
          manifestSha256: manifest.manifestSha256
        }
      })
    ).toThrow('orcad_migration_committed_source_cannot_be_released')
  })

  it('retires only the committed source catalog and survives restart idempotently', async () => {
    const { store, manifest } = setupSource()
    store.beginOrcadMigrationSourceCutover(manifest, 'environment-1')
    store.markOrcadMigrationDestinationCommitted(manifest.migrationId, {
      state: 'committed',
      migrationId: manifest.migrationId,
      manifestSha256: manifest.manifestSha256,
      receipt: receipt(manifest)
    })

    expect(
      store.retireOrcadMigrationSourceCatalog(manifest.migrationId, {
        now: () => new Date('2026-08-30T12:04:00.000Z')
      })
    ).toMatchObject({ phase: 'source-retired', retiredAt: '2026-08-30T12:04:00.000Z' })
    expect(store.getRepos()).toEqual([])
    expect(store.getFolderWorkspaces()).toEqual([])
    expect(store.getProjectGroups()).toEqual([])
    expect(store.getSshTarget(TARGET.id)?.owner).toEqual({
      type: 'on-demand-runtime',
      runtimeId: 'managed-orcad:environment-1'
    })
    await store.flushPendingOrThrowAsync()

    const restored = createStore()
    expect(restored.retireOrcadMigrationSourceCatalog(manifest.migrationId)).toMatchObject({
      phase: 'source-retired',
      retiredAt: '2026-08-30T12:04:00.000Z'
    })
    expect(restored.getRepos()).toEqual([])
  })

  it('retires only receipt-covered dormant state and preserves the shared source namespace', async () => {
    const { store, manifest, sourceNamespaceKey } = setupSource({
      dormantState: true,
      dormantSession: true
    })
    expect(manifest.payload.dormantState).toMatchObject({
      worktreeMeta: [{ worktreeId: 'repo-1::/srv/repo-1-worktree' }],
      sparsePresets: [{ id: 'preset-1' }],
      retiredWorktreeNames: [{ repoId: 'repo-1' }]
    })
    expect(manifest.payload.dormantState?.workspaceSession?.tabsByWorktree).toMatchObject({
      'repo-1::/srv/repo-1-worktree': [{ id: 'tab-dormant', ptyId: null }],
      [`folder:${manifest.payload.folderWorkspaces[0].id}`]: [
        { id: 'tab-folder-dormant', ptyId: null }
      ]
    })
    expect(manifest.payload.dormantState?.retiredWorktreeNamespaces[0]?.namespaceKey).toMatch(
      /^local:/
    )
    commitDestination(store, manifest)
    expect(store.getOrcadMigrationSourceDependencyCensus(manifest.migrationId).totalCount).toBe(0)

    store.retireOrcadMigrationSourceCatalog(manifest.migrationId)

    const worktreeId = 'repo-1::/srv/repo-1-worktree'
    expect(store.getWorktreeMeta(worktreeId)).toBeUndefined()
    expect(store.getWorktreeLineage(worktreeId)).toBeUndefined()
    expect(store.getWorkspaceLineage(worktreeWorkspaceKey(worktreeId))).toBeUndefined()
    expect(store.getSparsePresets('repo-1')).toEqual([])
    expect(store.getRetiredWorktreeNameRegistry('repo-1').names).toEqual([])
    expect(store.getWorkspaceSession(`ssh:${TARGET.id}`).tabsByWorktree).toEqual({})
    expect(sourceNamespaceKey).not.toBeNull()
    if (!sourceNamespaceKey) {
      throw new Error('expected source namespace')
    }
    expect(store.getRetiredWorktreeNameRegistryForNamespace(sourceNamespaceKey).names).toContain(
      'seahorse'
    )
    await store.flushPendingOrThrowAsync()

    expect(createStore().retireOrcadMigrationSourceCatalog(manifest.migrationId)).toMatchObject({
      phase: 'source-retired'
    })
  })

  it('drops a stale shutdown reconnect marker after every source PTY lease is final', () => {
    const { store } = setupSource({ dormantState: true, dormantSession: true })
    const worktreeId = 'repo-1::/srv/repo-1-worktree'
    store.setWorkspaceSession(
      {
        ...store.getWorkspaceSession(`ssh:${TARGET.id}`),
        activeWorktreeIdsOnShutdown: [worktreeId]
      },
      `ssh:${TARGET.id}`
    )
    store.upsertSshRemotePtyLease({
      targetId: TARGET.id,
      ptyId: 'pty-finished',
      worktreeId,
      state: 'terminated'
    })

    const manifest = createOrcadMigrationManifest(store, TARGET, {
      migrationId: 'migration-stale-shutdown-marker',
      destinationEnvironmentId: 'environment-1'
    })

    expect(manifest.payload.dormantState?.workspaceSession?.activeWorktreeIdsOnShutdown).toEqual([])
    expect(() => store.beginOrcadMigrationSourceCutover(manifest, 'environment-1')).not.toThrow()
  })

  it.each(['detached', 'expired'] as const)(
    'keeps a shutdown marker blocked for a %s lease',
    (state) => {
      const { store } = setupSource({ dormantState: true, dormantSession: true })
      const worktreeId = 'repo-1::/srv/repo-1-worktree'
      store.setWorkspaceSession(
        {
          ...store.getWorkspaceSession(`ssh:${TARGET.id}`),
          activeWorktreeIdsOnShutdown: [worktreeId]
        },
        `ssh:${TARGET.id}`
      )
      store.upsertSshRemotePtyLease({
        targetId: TARGET.id,
        ptyId: 'pty-detached',
        worktreeId,
        state
      })

      const manifest = createOrcadMigrationManifest(store, TARGET, {
        migrationId: 'migration-live-shutdown-marker',
        destinationEnvironmentId: 'environment-1'
      })

      expect(manifest.payload.dormantState?.workspaceSession).toBeUndefined()
      expect(() => store.beginOrcadMigrationSourceCutover(manifest, 'environment-1')).toThrow(
        'orcad_migration_source_terminal_lease_unresolved'
      )
    }
  )

  it('rekeys and retires disabled automations with final run history', () => {
    const { store, manifest, dormantAutomationId } = setupSource({ dormantAutomation: true })
    expect(manifest.payload.dormantState?.automations).toEqual([
      expect.objectContaining({
        id: dormantAutomationId,
        enabled: false,
        executionTargetType: 'local',
        executionTargetId: 'local',
        schedulerOwner: 'remote_host_service',
        runContext: expect.objectContaining({ hostId: 'local', repoId: 'repo-1' })
      })
    ])
    expect(manifest.payload.dormantState?.automationRuns).toEqual([
      expect.objectContaining({
        automationId: dormantAutomationId,
        status: 'completed',
        outputSnapshot: expect.objectContaining({ content: 'all green' })
      })
    ])
    commitDestination(store, manifest)
    store.retireOrcadMigrationSourceCatalog(manifest.migrationId)

    expect(store.listAutomations()).toEqual([])
    expect(store.listAutomationRuns()).toEqual([])
  })

  it('keeps a disabled automation when it changes after fencing', () => {
    const { store, manifest, dormantAutomationId } = setupSource({ dormantAutomation: true })
    if (!dormantAutomationId) {
      throw new Error('expected dormant automation')
    }
    store.beginOrcadMigrationSourceCutover(manifest, 'environment-1')
    const expectedOwner = store.automationOwnerPrecondition(dormantAutomationId)
    if (!expectedOwner) {
      throw new Error('expected automation owner')
    }
    store.updateAutomation(
      dormantAutomationId,
      { name: 'Changed after fencing' },
      { expectedOwner }
    )

    expect(store.getOrcadMigrationSourceDependencyCensus(manifest.migrationId)).toMatchObject({
      counts: { automation: 1, 'automation-run': 1 }
    })
    expect(() => store.assertOrcadMigrationSourceDependenciesAbsent(manifest.migrationId)).toThrow(
      'orcad_migration_source_dependencies_present'
    )
    expect(store.listAutomations()).toEqual([
      expect.objectContaining({ id: dormantAutomationId, name: 'Changed after fencing' })
    ])
  })

  it('keeps a disabled automation with an in-flight run on the source', () => {
    const { store } = setupSource()
    const automationId = addDormantAutomation(store, false)
    const manifest = createOrcadMigrationManifest(store, TARGET, {
      migrationId: 'migration-in-flight-automation'
    })

    expect(manifest.payload.dormantState?.automations).toBeUndefined()
    expect(() => store.beginOrcadMigrationSourceCutover(manifest, 'environment-1')).toThrow(
      'orcad_migration_source_dependencies_present'
    )
    expect(store.listAutomations()).toEqual([expect.objectContaining({ id: automationId })])
    expect(store.listAutomationRuns(automationId)).toEqual([
      expect.objectContaining({ status: 'pending' })
    ])
  })

  it('refuses source retirement before commit or after dependent-state drift', () => {
    const beforeCommit = setupSource()
    beforeCommit.store.beginOrcadMigrationSourceCutover(beforeCommit.manifest, 'environment-1')
    expect(() =>
      beforeCommit.store.retireOrcadMigrationSourceCatalog(beforeCommit.manifest.migrationId)
    ).toThrow('orcad_migration_destination_not_committed')

    const afterCommit = setupSource()
    afterCommit.store.beginOrcadMigrationSourceCutover(afterCommit.manifest, 'environment-1')
    afterCommit.store.markOrcadMigrationDestinationCommitted(afterCommit.manifest.migrationId, {
      state: 'committed',
      migrationId: afterCommit.manifest.migrationId,
      manifestSha256: afterCommit.manifest.manifestSha256,
      receipt: receipt(afterCommit.manifest)
    })
    afterCommit.store.setWorkspaceSession(
      {
        ...afterCommit.store.getWorkspaceSession(`ssh:${TARGET.id}`),
        activeConnectionIdsAtShutdown: [TARGET.id]
      },
      `ssh:${TARGET.id}`
    )

    expect(() =>
      afterCommit.store.retireOrcadMigrationSourceCatalog(afterCommit.manifest.migrationId)
    ).toThrow('orcad_migration_source_dependencies_present')
    expect(afterCommit.store.getRepos().map((repo) => repo.id)).toEqual(['repo-1'])
    expect(afterCommit.store.getFolderWorkspaces()).toHaveLength(1)
  })

  it('preserves same-id rows owned by another execution host', () => {
    const { store, manifest } = setupSource()
    store.addRepo({
      id: 'repo-1',
      path: '/srv/other-repo',
      displayName: 'Other repository',
      badgeColor: '#737373',
      addedAt: 2,
      connectionId: 'ssh-other',
      executionHostId: 'ssh:ssh-other'
    })
    commitDestination(store, manifest)

    store.retireOrcadMigrationSourceCatalog(manifest.migrationId)

    expect(store.getRepos()).toEqual([
      expect.objectContaining({
        id: 'repo-1',
        connectionId: 'ssh-other',
        executionHostId: 'ssh:ssh-other'
      })
    ])
  })

  it('preserves a shared local project-group ancestor', () => {
    const { store, manifest, localAncestor } = setupSource({ localAncestor: true })
    store.addRepo({
      id: 'repo-local',
      path: '/local/repo',
      displayName: 'Local repository',
      badgeColor: '#737373',
      addedAt: 2,
      projectGroupId: localAncestor?.id
    })
    commitDestination(store, manifest)

    store.retireOrcadMigrationSourceCatalog(manifest.migrationId)

    expect(store.getRepos().map((repo) => repo.id)).toEqual(['repo-local'])
    expect(store.getProjectGroups()).toEqual([
      expect.objectContaining({ id: localAncestor?.id, connectionId: null })
    ])
  })

  it('retries a failed retirement flush without resurrecting source rows', async () => {
    const { store, manifest } = setupSource()
    commitDestination(store, manifest)
    const flushPendingOrThrowAsync = store.flushPendingOrThrowAsync.bind(store)
    const flush = vi
      .spyOn(store, 'flushPendingOrThrowAsync')
      .mockRejectedValueOnce(new Error('disk full'))
      .mockImplementation((options) => flushPendingOrThrowAsync(options))
    const args = { store, migrationId: manifest.migrationId }

    await expect(retireOrcadMigrationSourceCatalogDurably(args)).rejects.toThrow('disk full')
    expect(store.getRepos()).toEqual([])
    await expect(retireOrcadMigrationSourceCatalogDurably(args)).resolves.toMatchObject({
      phase: 'source-retired'
    })
    flush.mockRestore()

    const restored = createStore()
    expect(restored.getRepos()).toEqual([])
    expect(restored.getOrcadMigrationSourceCutover(manifest.migrationId)).toMatchObject({
      phase: 'source-retired'
    })
  })

  it('fails closed if source rows reappear after retirement', () => {
    const { store, manifest } = setupSource()
    commitDestination(store, manifest)
    store.retireOrcadMigrationSourceCatalog(manifest.migrationId)
    store.addRepo({
      id: 'repo-1',
      path: '/srv/repo-1',
      displayName: 'Repository',
      badgeColor: '#737373',
      addedAt: 2,
      connectionId: TARGET.id,
      executionHostId: `ssh:${TARGET.id}`
    })

    expect(() => store.retireOrcadMigrationSourceCatalog(manifest.migrationId)).toThrow(
      'orcad_migration_source_catalog_reappeared'
    )
    expect(store.getSshTarget(TARGET.id)?.owner).toEqual({
      type: 'on-demand-runtime',
      runtimeId: 'managed-orcad:environment-1'
    })
  })

  it('does not remove source rows when retirement timestamp creation fails', () => {
    const { store, manifest } = setupSource()
    commitDestination(store, manifest)

    expect(() =>
      store.retireOrcadMigrationSourceCatalog(manifest.migrationId, {
        now: () => new Date(Number.NaN)
      })
    ).toThrow()
    expect(store.getRepos().map((repo) => repo.id)).toEqual(['repo-1'])
    expect(store.getFolderWorkspaces()).toHaveLength(1)
    expect(store.getOrcadMigrationSourceCutover(manifest.migrationId)).toMatchObject({
      phase: 'destination-committed'
    })
  })

  it('releases the fence only with exact absent destination evidence', () => {
    const { store, manifest } = setupSource()
    store.beginOrcadMigrationSourceCutover(manifest, 'environment-1')

    expect(() =>
      store.releaseOrcadMigrationSourceCutover(manifest.migrationId, {
        kind: 'catalog-absent',
        state: {
          state: 'absent',
          migrationId: 'migration-other',
          manifestSha256: manifest.manifestSha256
        }
      })
    ).toThrow('orcad_migration_destination_state_identity_mismatch')

    store.releaseOrcadMigrationSourceCutover(manifest.migrationId, {
      kind: 'catalog-absent',
      state: {
        state: 'absent',
        migrationId: manifest.migrationId,
        manifestSha256: manifest.manifestSha256
      }
    })
    expect(store.getSshTarget(TARGET.id)?.owner).toBeUndefined()
    expect(store.getOrcadMigrationSourceCutover(manifest.migrationId)).toBeNull()
    expect(store.getRepos().map((repo) => repo.id)).toEqual(['repo-1'])
  })

  it('detects source catalog drift while keeping the fence and source rows', () => {
    const { store, manifest } = setupSource()
    store.beginOrcadMigrationSourceCutover(manifest, 'environment-1')
    store.addRepo({
      id: 'repo-late',
      path: '/srv/repo-late',
      displayName: 'Late repository',
      badgeColor: '#737373',
      addedAt: 2,
      connectionId: TARGET.id,
      executionHostId: `ssh:${TARGET.id}`
    })

    expect(() => store.assertOrcadMigrationSourceCatalogUnchanged(manifest.migrationId)).toThrow(
      'orcad_migration_source_catalog_changed'
    )
    expect(store.getSshTarget(TARGET.id)?.owner).toMatchObject({
      type: 'on-demand-runtime',
      runtimeId: 'managed-orcad:environment-1'
    })
    expect(store.getRepos().map((repo) => repo.id)).toEqual(['repo-1', 'repo-late'])
  })

  it('detects transferred dormant-state drift after fencing and preserves the source', () => {
    const { store, manifest } = setupSource({ dormantState: true })
    const worktreeId = 'repo-1::/srv/repo-1-worktree'
    store.beginOrcadMigrationSourceCutover(manifest, 'environment-1')
    store.setWorktreeMeta(worktreeId, { comment: 'Changed after fencing' })

    expect(store.getOrcadMigrationSourceDependencyCensus(manifest.migrationId)).toMatchObject({
      counts: { 'worktree-metadata': 1 }
    })
    expect(() => store.assertOrcadMigrationSourceDependenciesAbsent(manifest.migrationId)).toThrow(
      'orcad_migration_source_dependencies_present'
    )
    expect(store.getWorktreeMeta(worktreeId)?.comment).toBe('Changed after fencing')
    expect(store.getRepos().map((repo) => repo.id)).toEqual(['repo-1'])
  })

  it('keeps cross-scope lineage blocked instead of partially migrating it', () => {
    const { store } = setupSource()
    const worktreeId = 'repo-1::/srv/repo-1-cross-scope'
    store.setWorktreeLineage(worktreeId, {
      worktreeId,
      worktreeInstanceId: 'instance-cross',
      parentWorktreeId: 'repo-other::/srv/other',
      parentWorktreeInstanceId: 'instance-other',
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: 5
    })
    const manifest = createOrcadMigrationManifest(store, TARGET, { migrationId: 'cross-scope' })

    expect(manifest.payload.dormantState?.worktreeLineage ?? []).toEqual([])
    expect(() => store.beginOrcadMigrationSourceCutover(manifest, 'environment-1')).toThrow(
      'orcad_migration_source_dependencies_present'
    )
    expect(store.getWorktreeLineage(worktreeId)).toBeDefined()
  })

  it('never re-admits a third source row after a projected-identity collision', () => {
    const { store } = setupSource()
    const worktreeId = 'repo-1::/srv/repo-1-collision'
    const meta = {
      displayName: 'Ambiguous dormant worktree',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 1,
      lastActivityAt: 5,
      hostId: `ssh:${TARGET.id}` as const
    }
    store.setWorktreeMeta(worktreeId, meta)
    store.setWorktreeMeta(`|${worktreeId}`, meta)
    store.setWorktreeMeta(`ssh:${TARGET.id}|${worktreeId}`, meta)
    const manifest = createOrcadMigrationManifest(store, TARGET, { migrationId: 'collision' })

    expect(manifest.payload.dormantState?.worktreeMeta ?? []).toEqual([])
    expect(() => store.beginOrcadMigrationSourceCutover(manifest, 'environment-1')).toThrow(
      'orcad_migration_source_dependencies_present'
    )
  })

  it('refuses a recoverable PTY session before assigning destination ownership', () => {
    const { store, manifest } = setupSource()
    const worktreeId = 'repo-1::/srv/repo-1-worktree'
    store.setWorkspaceSession(
      {
        ...store.getWorkspaceSession(`ssh:${TARGET.id}`),
        tabsByWorktree: {
          [worktreeId]: [
            {
              id: 'tab-dormant',
              ptyId: 'pty-recoverable',
              worktreeId,
              title: 'Dormant terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        }
      },
      `ssh:${TARGET.id}`
    )

    expect(() => store.beginOrcadMigrationSourceCutover(manifest, 'environment-1')).toThrow(
      'orcad_migration_source_dependencies_present'
    )
    expect(store.getSshTarget(TARGET.id)?.owner).toBeUndefined()
    expect(store.listOrcadMigrationSourceCutovers()).toEqual([])
  })

  it('transfers dormant source-partition focus without treating it as live ownership', () => {
    const { store } = setupSource()
    const worktreeId = 'repo-1::/srv/repo-1-worktree'
    store.setWorkspaceSession(
      {
        ...store.getWorkspaceSession(`ssh:${TARGET.id}`),
        activeRepoId: 'repo-1',
        activeWorktreeId: worktreeId,
        activeWorkspaceKey: worktreeWorkspaceKey(worktreeId),
        activeWorkspaceExecutionHostId: `ssh:${TARGET.id}`,
        activeTabId: 'tab-dormant',
        tabsByWorktree: {
          [worktreeId]: [
            {
              id: 'tab-dormant',
              ptyId: null,
              worktreeId,
              title: 'Dormant terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        }
      },
      `ssh:${TARGET.id}`
    )

    const manifest = createOrcadMigrationManifest(store, TARGET, {
      migrationId: 'migration-focus',
      destinationEnvironmentId: 'environment-1'
    })
    expect(manifest.payload.dormantState?.workspaceSession).toMatchObject({
      activeRepoId: 'repo-1',
      activeWorktreeId: worktreeId,
      activeWorkspaceKey: worktreeWorkspaceKey(worktreeId),
      activeWorkspaceExecutionHostId: 'local',
      activeTabId: 'tab-dormant'
    })
    expect(() => store.beginOrcadMigrationSourceCutover(manifest, 'environment-1')).not.toThrow()
  })

  it('detects dependent-state drift after fencing and keeps the source intact', () => {
    const { store, manifest } = setupSource()
    store.beginOrcadMigrationSourceCutover(manifest, 'environment-1')
    store.setWorkspaceSession(
      {
        ...store.getWorkspaceSession(`ssh:${TARGET.id}`),
        activeConnectionIdsAtShutdown: [TARGET.id]
      },
      `ssh:${TARGET.id}`
    )

    expect(store.getOrcadMigrationSourceDependencyCensus(manifest.migrationId)).toMatchObject({
      counts: { 'workspace-session': 1 }
    })
    expect(() => store.assertOrcadMigrationSourceDependenciesAbsent(manifest.migrationId)).toThrow(
      'orcad_migration_source_dependencies_present'
    )
    expect(store.getSshTarget(TARGET.id)?.owner).toMatchObject({
      type: 'on-demand-runtime',
      runtimeId: 'managed-orcad:environment-1'
    })
    expect(store.getRepos().map((repo) => repo.id)).toEqual(['repo-1'])
  })

  it.each(['attached', 'detached', 'expired'] as const)(
    'refuses to fence a source with a %s PTY lease',
    (state) => {
      const { store, manifest } = setupSource()
      store.upsertSshRemotePtyLease({
        targetId: TARGET.id,
        ptyId: 'pty-live',
        state
      })

      expect(() => store.beginOrcadMigrationSourceCutover(manifest, 'environment-1')).toThrow(
        'orcad_migration_source_terminal_lease_unresolved'
      )
      expect(store.getSshTarget(TARGET.id)?.owner).toBeUndefined()
    }
  )

  it('preserves source and recovery authority when an expired lease appears after fencing', async () => {
    const { store, manifest } = setupSource()
    store.beginOrcadMigrationSourceCutover(manifest, 'environment-1')
    store.upsertSshRemotePtyLease({ targetId: TARGET.id, ptyId: 'unreachable', state: 'expired' })
    await store.upsertSshPtyConsumerRecovery({
      targetId: TARGET.id,
      clientInstanceId: 'client',
      serverBuildId: 'build',
      clientGeneration: 1,
      ownerGeneration: 1,
      ownerLease: 'owner'
    })
    await store.flushPendingOrThrowAsync()
    const restored = createStore()
    expect(restored.getOrcadMigrationSourceDependencyCensus(manifest.migrationId)).toMatchObject({
      counts: { 'terminal-lease': 1, 'terminal-recovery': 1 }
    })
    expect(() =>
      restored.markOrcadMigrationDestinationStaged(manifest.migrationId, {
        state: 'staged',
        migrationId: manifest.migrationId,
        manifestSha256: manifest.manifestSha256,
        stagedAt: '2026-09-07T00:00:00.000Z'
      })
    ).toThrow('dependencies_present')
    restored.markOrcadMigrationDestinationCommitted(manifest.migrationId, {
      state: 'committed',
      migrationId: manifest.migrationId,
      manifestSha256: manifest.manifestSha256,
      receipt: receipt(manifest)
    })
    expect(() => restored.retireOrcadMigrationSourceCatalog(manifest.migrationId)).toThrow(
      'dependencies_present'
    )
    expect(restored.getRepos().map((repo) => repo.id)).toEqual(['repo-1'])
    expect(restored.getSshTarget(TARGET.id)?.owner).toBeDefined()
  })

  it('preserves saved forwards on the fenced source target without a second listener', () => {
    const { store } = setupSource()
    const forwards = [{ localPort: 9000, remoteHost: '127.0.0.1', remotePort: 6768 }]
    store.updateSshTarget(TARGET.id, { portForwards: forwards })
    const manifest = createOrcadMigrationManifest(store, TARGET, {
      migrationId: 'migration-forwards',
      destinationEnvironmentId: 'environment-1'
    })

    commitDestination(store, manifest)
    store.retireOrcadMigrationSourceCatalog(manifest.migrationId)

    expect(store.getSshTarget(TARGET.id)?.portForwards).toEqual(forwards)
  })

  it('rekeys desktop routing to the managed runtime during source retirement', () => {
    const { store } = setupSource()
    const worktreeId = 'repo-1::/srv/repo-1-worktree'
    store.updateUI({
      lastActiveRepoId: 'repo-1',
      lastActiveWorktreeId: `ssh:${TARGET.id}|${worktreeId}`,
      workspaceHostScope: `ssh:${TARGET.id}`,
      visibleWorkspaceHostIds: [`ssh:${TARGET.id}`],
      workspaceHostOrder: [`ssh:${TARGET.id}`],
      manualRepoOrder: [{ hostId: `ssh:${TARGET.id}`, repoId: 'repo-1' }],
      showDotfilesByWorktree: { [`ssh:${TARGET.id}|${worktreeId}`]: false },
      automationHostFilter: {
        kind: 'host',
        hostKey: `host:desktop:ssh:${encodeURIComponent(TARGET.id)}`
      }
    })
    const manifest = createOrcadMigrationManifest(store, TARGET, {
      migrationId: 'migration-routing',
      destinationEnvironmentId: 'environment-1'
    })

    commitDestination(store, manifest)
    store.retireOrcadMigrationSourceCatalog(manifest.migrationId)

    expect(store.getUI()).toMatchObject({
      lastActiveWorktreeId: `runtime:environment-1|${worktreeId}`,
      workspaceHostScope: 'runtime:environment-1',
      visibleWorkspaceHostIds: ['runtime:environment-1'],
      workspaceHostOrder: ['runtime:environment-1'],
      manualRepoOrder: [{ hostId: 'runtime:environment-1', repoId: 'repo-1' }],
      showDotfilesByWorktree: {
        [`runtime:environment-1|${worktreeId}`]: false
      },
      automationHostFilter: { kind: 'host', hostKey: 'host:runtime:environment-1:self' }
    })
  })

  it('admits a fifth migration after compacting a completed source-retired journal', () => {
    const { store } = setupSource()
    const targets = [
      TARGET,
      ...Array.from({ length: 4 }, (_, index) => ({
        ...TARGET,
        id: `ssh-capacity-${index + 1}`,
        label: `Capacity ${index + 1}`,
        generation: index + 2
      }))
    ]
    for (const target of targets.slice(1)) {
      store.addSshTarget(target)
    }

    for (const [index, target] of targets.entries()) {
      const manifest = createOrcadMigrationManifest(store, target, {
        migrationId: `migration-capacity-${index}`,
        destinationEnvironmentId: `environment-capacity-${index}`
      })
      commitDestination(store, manifest)
      store.retireOrcadMigrationSourceCatalog(manifest.migrationId)
    }

    expect(store.listOrcadMigrationSourceCutovers()).toHaveLength(4)
    expect(
      store.listOrcadMigrationSourceCutovers().map((entry) => entry.manifest.migrationId)
    ).toEqual([
      'migration-capacity-1',
      'migration-capacity-2',
      'migration-capacity-3',
      'migration-capacity-4'
    ])
  })
})
