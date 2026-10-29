import { describe, expect, it, vi } from 'vitest'
import type {
  OrcadMigrationCatalogAbortResult,
  OrcadMigrationCatalogReferenceAbortResult,
  OrcadMigrationCatalogState
} from '../../shared/orcad-migration/orcad-migration-manifest'
import { orcadMigrationCutoverFixture } from '../ssh/orcad-migration-cutover-fixture'
import {
  abortStagedOrcadMigrationCatalogByReferenceDurably,
  abortStagedOrcadMigrationCatalogDurably,
  commitStagedOrcadMigrationCatalogDurably,
  stageOrcadMigrationCatalogDurably
} from './orcad-migration-catalog-import'

const { manifest } = orcadMigrationCutoverFixture()
const reference = { migrationId: manifest.migrationId, manifestSha256: manifest.manifestSha256 }

describe('durable orcad migration catalog import', () => {
  it('does not acknowledge staging until its dormant manifest is durable', async () => {
    const diskError = new Error('disk full')
    const staged: OrcadMigrationCatalogState = {
      state: 'staged',
      ...reference,
      stagedAt: '2026-10-01T00:00:01.000Z'
    }
    const stage = vi.fn().mockReturnValue(staged)
    const flush = vi.fn().mockRejectedValueOnce(diskError).mockResolvedValueOnce(undefined)
    const args = {
      store: {
        stageOrcadMigrationCatalog: stage,
        flushPendingOrThrowAsync: flush
      },
      manifest
    }

    await expect(stageOrcadMigrationCatalogDurably(args)).rejects.toBe(diskError)
    await expect(stageOrcadMigrationCatalogDurably(args)).resolves.toBe(staged)
    expect(stage).toHaveBeenCalledTimes(2)
    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('publishes a committed catalog only after its receipt is durable', async () => {
    const diskError = new Error('disk full')
    const committed: OrcadMigrationCatalogState = {
      state: 'committed',
      ...reference,
      receipt: {
        version: manifest.version,
        ...reference,
        source: manifest.source,
        importedAt: '2026-10-01T00:00:02.000Z',
        repositoryIds: [],
        projectGroupIds: [],
        folderWorkspaceIds: []
      }
    }
    const commit = vi.fn().mockReturnValue(committed)
    const flush = vi.fn().mockRejectedValueOnce(diskError).mockResolvedValueOnce(undefined)
    const onDurableCommit = vi.fn()
    const args = {
      store: {
        commitStagedOrcadMigrationCatalog: commit,
        flushPendingOrThrowAsync: flush
      },
      manifest,
      onDurableCommit
    }

    await expect(commitStagedOrcadMigrationCatalogDurably(args)).rejects.toBe(diskError)
    expect(onDurableCommit).not.toHaveBeenCalled()
    await expect(commitStagedOrcadMigrationCatalogDurably(args)).resolves.toBe(committed)
    expect(onDurableCommit).toHaveBeenCalledOnce()
  })

  it('reflushes an already-absent abort after the first flush failed', async () => {
    const aborted: OrcadMigrationCatalogAbortResult = {
      state: 'absent',
      ...reference,
      aborted: true
    }
    const unchanged: OrcadMigrationCatalogAbortResult = { ...aborted, aborted: false }
    const abort = vi.fn().mockReturnValueOnce(aborted).mockReturnValueOnce(unchanged)
    const flush = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined)
    const args = {
      store: {
        abortStagedOrcadMigrationCatalog: abort,
        flushPendingOrThrowAsync: flush
      },
      manifest
    }

    await expect(abortStagedOrcadMigrationCatalogDurably(args)).rejects.toThrow('disk full')
    await expect(abortStagedOrcadMigrationCatalogDurably(args)).resolves.toEqual({
      ...unchanged,
      durableAbsent: true
    })
    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('answers an abort by reference absent only once its flush succeeds', async () => {
    const aborted: OrcadMigrationCatalogReferenceAbortResult = {
      ...reference,
      state: 'absent',
      aborted: true
    }
    const unchanged: OrcadMigrationCatalogReferenceAbortResult = { ...aborted, aborted: false }
    const abort = vi.fn().mockReturnValueOnce(aborted).mockReturnValueOnce(unchanged)
    const flush = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined)
    const args = {
      store: {
        abortStagedOrcadMigrationCatalogByReference: abort,
        flushPendingOrThrowAsync: flush
      },
      reference
    }

    await expect(abortStagedOrcadMigrationCatalogByReferenceDurably(args)).rejects.toThrow(
      'disk full'
    )
    await expect(abortStagedOrcadMigrationCatalogByReferenceDurably(args)).resolves.toEqual({
      ...unchanged,
      durableAbsent: true
    })
    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('flushes before answering committed by reference, and says so', async () => {
    const reference = { migrationId: 'move-1', manifestSha256: 'a'.repeat(64) }
    const committed = { ...reference, state: 'committed' as const, aborted: false }
    const flush = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined)
    const args = {
      store: {
        abortStagedOrcadMigrationCatalogByReference: vi.fn().mockReturnValue(committed),
        flushPendingOrThrowAsync: flush
      },
      reference
    }

    // A committed answer whose flush failed must not reach a caller that would act on it.
    await expect(abortStagedOrcadMigrationCatalogByReferenceDurably(args)).rejects.toThrow(
      'disk full'
    )
    await expect(abortStagedOrcadMigrationCatalogByReferenceDurably(args)).resolves.toEqual({
      ...committed,
      durableCommitted: true
    })
  })
})
