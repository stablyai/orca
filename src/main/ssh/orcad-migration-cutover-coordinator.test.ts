import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCAD_MIGRATION_MANIFEST_VERSION,
  type OrcadMigrationCatalogState,
  type OrcadMigrationImportReceipt,
  type OrcadMigrationManifest
} from '../../shared/orcad-migration-manifest'
import {
  ORCAD_MIGRATION_SOURCE_CUTOVER_VERSION,
  type OrcadMigrationSourceCutover
} from '../../shared/orcad-migration-source-cutover'
import {
  abortOrcadMigrationCutover,
  beginOrcadMigrationSourceCutoverDurably,
  commitOrcadMigrationDestination,
  retireOrcadMigrationSourceCatalogDurably,
  stageOrcadMigrationDestination
} from './orcad-migration-cutover-coordinator'

const MANIFEST: OrcadMigrationManifest = {
  version: ORCAD_MIGRATION_MANIFEST_VERSION,
  migrationId: 'migration-1',
  createdAt: '2026-08-30T12:00:00.000Z',
  source: { sshTargetId: 'ssh-prod', sshTargetGeneration: 8, targetLabel: 'Production' },
  payload: { repositories: [], projectGroups: [], folderWorkspaces: [] },
  manifestSha256: 'a'.repeat(64)
}

function receipt(): OrcadMigrationImportReceipt {
  return {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId: MANIFEST.migrationId,
    manifestSha256: MANIFEST.manifestSha256,
    source: MANIFEST.source,
    importedAt: '2026-08-30T12:03:00.000Z',
    repositoryIds: [],
    projectGroupIds: [],
    folderWorkspaceIds: []
  }
}

function sourceFenced(): OrcadMigrationSourceCutover {
  return {
    version: ORCAD_MIGRATION_SOURCE_CUTOVER_VERSION,
    phase: 'source-fenced',
    destinationEnvironmentId: 'environment-1',
    manifest: MANIFEST,
    startedAt: '2026-08-30T12:00:00.000Z',
    updatedAt: '2026-08-30T12:00:00.000Z'
  }
}

function stagedState(): Extract<OrcadMigrationCatalogState, { state: 'staged' }> {
  return {
    state: 'staged',
    migrationId: MANIFEST.migrationId,
    manifestSha256: MANIFEST.manifestSha256,
    stagedAt: '2026-08-30T12:02:00.000Z'
  }
}

function committedState(): Extract<OrcadMigrationCatalogState, { state: 'committed' }> {
  return {
    state: 'committed',
    migrationId: MANIFEST.migrationId,
    manifestSha256: MANIFEST.manifestSha256,
    receipt: receipt()
  }
}

function sourceRetired(): OrcadMigrationSourceCutover {
  return {
    ...sourceFenced(),
    phase: 'source-retired',
    receipt: receipt(),
    retiredAt: '2026-08-30T12:04:00.000Z'
  }
}

function absentState(): Extract<OrcadMigrationCatalogState, { state: 'absent' }> {
  return {
    state: 'absent',
    migrationId: MANIFEST.migrationId,
    manifestSha256: MANIFEST.manifestSha256
  }
}

function createStoreDouble(initial: OrcadMigrationSourceCutover | null = sourceFenced()) {
  let current = initial
  const store = {
    assertOrcadMigrationSourceDependenciesAbsent: vi.fn(),
    assertOrcadMigrationSourceCatalogUnchanged: vi.fn(),
    beginOrcadMigrationSourceCutover: vi.fn(() => {
      current ??= sourceFenced()
      return current
    }),
    flushPendingOrThrowAsync: vi.fn(async () => undefined),
    getOrcadMigrationSourceCutover: vi.fn(() => current),
    markOrcadMigrationDestinationStaged: vi.fn(
      (_migrationId: string, state: ReturnType<typeof stagedState>) => {
        current = {
          ...sourceFenced(),
          phase: 'destination-staged',
          stagedAt: state.stagedAt
        }
        return current
      }
    ),
    markOrcadMigrationDestinationCommitted: vi.fn(
      (_migrationId: string, state: ReturnType<typeof committedState>) => {
        current = {
          ...sourceFenced(),
          phase: 'destination-committed',
          receipt: state.receipt
        }
        return current
      }
    ),
    readOrcadMigrationSourceSnapshotChunk: vi.fn(),
    releaseOrcadMigrationSourceCutover: vi.fn(() => {
      current = null
    }),
    retireOrcadMigrationSourceCatalog: vi.fn(() => {
      current = sourceRetired()
      return current
    })
  }
  return store
}

function remoteOperations() {
  return {
    abort: vi.fn().mockResolvedValue(absentState()),
    commit: vi.fn().mockResolvedValue(committedState()),
    read: vi.fn(),
    snapshot: vi.fn(),
    stage: vi.fn().mockResolvedValue(stagedState())
  }
}

beforeEach(() => vi.clearAllMocks())

describe('orcad migration cutover coordinator', () => {
  it('does not acknowledge the source fence until its generation flushes and supports retry', async () => {
    const store = createStoreDouble(null)
    store.flushPendingOrThrowAsync
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined)
    const args = {
      store,
      manifest: MANIFEST,
      destinationEnvironmentId: 'environment-1',
      destinationName: 'Managed production'
    }

    await expect(beginOrcadMigrationSourceCutoverDurably(args)).rejects.toThrow('disk full')
    await expect(beginOrcadMigrationSourceCutoverDurably(args)).resolves.toMatchObject({
      phase: 'source-fenced'
    })
    expect(store.flushPendingOrThrowAsync).toHaveBeenCalledTimes(2)
    expect(store.beginOrcadMigrationSourceCutover).toHaveBeenLastCalledWith(
      MANIFEST,
      'environment-1',
      expect.objectContaining({ destinationName: 'Managed production' })
    )
  })

  it('reflushes an observed stage after a lost response', async () => {
    const store = createStoreDouble()
    const remote = remoteOperations()
    remote.read.mockResolvedValueOnce(absentState()).mockResolvedValueOnce(stagedState())
    remote.stage.mockRejectedValueOnce(new Error('response lost'))

    await expect(
      stageOrcadMigrationDestination({
        store,
        migrationId: MANIFEST.migrationId,
        pairingCode: 'pairing',
        options: { remote }
      })
    ).resolves.toMatchObject({ phase: 'destination-staged' })
    expect(store.markOrcadMigrationDestinationStaged).toHaveBeenCalledOnce()
    expect(remote.stage).toHaveBeenCalledTimes(2)
    expect(store.releaseOrcadMigrationSourceCutover).not.toHaveBeenCalled()
  })

  it('refuses remote mutation when dependent state appears behind the source fence', async () => {
    const store = createStoreDouble()
    const remote = remoteOperations()
    store.assertOrcadMigrationSourceDependenciesAbsent.mockImplementationOnce(() => {
      throw new Error('orcad_migration_source_dependencies_present')
    })

    await expect(
      stageOrcadMigrationDestination({
        store,
        migrationId: MANIFEST.migrationId,
        pairingCode: 'pairing',
        options: { remote }
      })
    ).rejects.toThrow('orcad_migration_source_dependencies_present')
    expect(remote.read).not.toHaveBeenCalled()
    expect(remote.stage).not.toHaveBeenCalled()
  })

  it('recovers a lost commit response and persists committed evidence', async () => {
    const store = createStoreDouble()
    const remote = remoteOperations()
    remote.read.mockResolvedValueOnce(stagedState()).mockResolvedValueOnce(committedState())
    remote.commit.mockRejectedValueOnce(new Error('response lost'))

    await expect(
      commitOrcadMigrationDestination({
        store,
        migrationId: MANIFEST.migrationId,
        pairingCode: 'pairing',
        options: { remote }
      })
    ).resolves.toMatchObject({ phase: 'destination-committed' })
    expect(store.markOrcadMigrationDestinationCommitted).toHaveBeenCalledOnce()
    expect(remote.commit).toHaveBeenCalledTimes(2)
    expect(store.releaseOrcadMigrationSourceCutover).not.toHaveBeenCalled()
  })

  it('does not acknowledge source retirement until its exact generation flushes', async () => {
    const store = createStoreDouble({
      ...sourceFenced(),
      phase: 'destination-committed',
      receipt: receipt()
    })
    store.flushPendingOrThrowAsync
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined)

    await expect(
      retireOrcadMigrationSourceCatalogDurably({
        store,
        migrationId: MANIFEST.migrationId
      })
    ).rejects.toThrow('disk full')
    await expect(
      retireOrcadMigrationSourceCatalogDurably({
        store,
        migrationId: MANIFEST.migrationId
      })
    ).resolves.toMatchObject({ phase: 'source-retired' })
    expect(store.flushPendingOrThrowAsync).toHaveBeenCalledTimes(2)
  })

  it('does not contact the destination again after durable source retirement', async () => {
    const store = createStoreDouble(sourceRetired())
    const remote = remoteOperations()

    await expect(
      commitOrcadMigrationDestination({
        store,
        migrationId: MANIFEST.migrationId,
        pairingCode: 'pairing',
        options: { remote }
      })
    ).resolves.toMatchObject({ phase: 'source-retired' })
    expect(remote.read).not.toHaveBeenCalled()
    expect(remote.commit).not.toHaveBeenCalled()
  })

  it('releases an old-host fence only after method-not-found proves stage is unsupported', async () => {
    const store = createStoreDouble()
    const remote = remoteOperations()
    remote.read.mockRejectedValueOnce(new Error('orcad_migration_state_failed:method not found'))

    await abortOrcadMigrationCutover({
      store,
      migrationId: MANIFEST.migrationId,
      pairingCode: 'pairing',
      options: { remote }
    })
    expect(store.releaseOrcadMigrationSourceCutover).toHaveBeenCalledWith(MANIFEST.migrationId, {
      kind: 'stage-method-unsupported'
    })
  })

  it('reflushes a lost abort response before releasing the source', async () => {
    const store = createStoreDouble()
    const remote = remoteOperations()
    remote.read.mockResolvedValueOnce(stagedState()).mockResolvedValueOnce(absentState())
    remote.abort.mockRejectedValueOnce(new Error('response lost'))

    await abortOrcadMigrationCutover({
      store,
      migrationId: MANIFEST.migrationId,
      pairingCode: 'pairing',
      options: { remote }
    })
    expect(remote.abort).toHaveBeenCalledTimes(2)
    expect(store.releaseOrcadMigrationSourceCutover).toHaveBeenCalledWith(MANIFEST.migrationId, {
      kind: 'catalog-absent',
      state: absentState()
    })
  })

  it.each(['stage', 'commit', 'abort'] as const)(
    'preserves source authority when %s remains unflushed despite accepted reads',
    async (operation) => {
      const store = createStoreDouble()
      const remote = remoteOperations()
      remote[operation].mockRejectedValue(new Error('disk full'))
      remote.read.mockResolvedValue(
        operation === 'commit'
          ? committedState()
          : operation === 'abort'
            ? absentState()
            : stagedState()
      )
      const run =
        operation === 'stage'
          ? stageOrcadMigrationDestination
          : operation === 'commit'
            ? commitOrcadMigrationDestination
            : abortOrcadMigrationCutover

      await expect(
        run({
          store,
          migrationId: MANIFEST.migrationId,
          pairingCode: 'pairing',
          options: { remote }
        })
      ).rejects.toThrow('disk full')
      expect(remote[operation]).toHaveBeenCalledTimes(2)
      expect(store.markOrcadMigrationDestinationStaged).not.toHaveBeenCalled()
      expect(store.markOrcadMigrationDestinationCommitted).not.toHaveBeenCalled()
      expect(store.releaseOrcadMigrationSourceCutover).not.toHaveBeenCalled()
      expect(store.retireOrcadMigrationSourceCatalog).not.toHaveBeenCalled()
    }
  )

  it.each(['stage', 'commit', 'abort'] as const)(
    'reflushes initially observed %s state before accepting recovery',
    async (operation) => {
      const store = createStoreDouble()
      const remote = remoteOperations()
      remote.read.mockResolvedValue(
        operation === 'commit'
          ? committedState()
          : operation === 'abort'
            ? absentState()
            : stagedState()
      )
      const run =
        operation === 'stage'
          ? stageOrcadMigrationDestination
          : operation === 'commit'
            ? commitOrcadMigrationDestination
            : abortOrcadMigrationCutover
      await run({
        store,
        migrationId: MANIFEST.migrationId,
        pairingCode: 'pairing',
        options: { remote }
      })
      expect(remote[operation]).toHaveBeenCalledOnce()
      if (operation === 'abort') {
        expect(store.releaseOrcadMigrationSourceCutover).toHaveBeenCalledOnce()
      } else {
        expect(store.releaseOrcadMigrationSourceCutover).not.toHaveBeenCalled()
      }
    }
  )

  it('records committed status and refuses rollback after commit', async () => {
    const store = createStoreDouble()
    const remote = remoteOperations()
    remote.read.mockResolvedValueOnce(committedState())

    await expect(
      abortOrcadMigrationCutover({
        store,
        migrationId: MANIFEST.migrationId,
        pairingCode: 'pairing',
        options: { remote }
      })
    ).rejects.toThrow('orcad_migration_committed_source_cannot_be_released')
    expect(store.markOrcadMigrationDestinationCommitted).toHaveBeenCalledOnce()
    expect(store.releaseOrcadMigrationSourceCutover).not.toHaveBeenCalled()
  })
})
