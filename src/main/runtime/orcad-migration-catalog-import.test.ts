import { describe, expect, it, vi } from 'vitest'
import type {
  OrcadMigrationCatalogAbortResult,
  OrcadMigrationCatalogState,
  OrcadMigrationImportResult,
  OrcadMigrationManifest
} from '../../shared/orcad-migration-manifest'
import {
  abortStagedOrcadMigrationCatalogDurably,
  commitStagedOrcadMigrationCatalogDurably,
  importOrcadMigrationCatalogDurably,
  stageOrcadMigrationCatalogDurably
} from './orcad-migration-catalog-import'

describe('durable orcad migration catalog import', () => {
  it('acknowledges only after a durable flush and safely retries a failed acknowledgement', async () => {
    const diskError = new Error('disk full')
    const imported = { status: 'imported' } as OrcadMigrationImportResult
    const replayed = { status: 'already-imported' } as OrcadMigrationImportResult
    const importCatalog = vi.fn().mockReturnValueOnce(imported).mockReturnValueOnce(replayed)
    const flush = vi.fn().mockRejectedValueOnce(diskError).mockResolvedValueOnce(undefined)
    const onDurableImport = vi.fn()
    const args = {
      store: {
        importOrcadMigrationCatalog: importCatalog,
        flushPendingOrThrowAsync: flush
      },
      manifest: {} as OrcadMigrationManifest,
      onDurableImport
    }

    await expect(importOrcadMigrationCatalogDurably(args)).rejects.toBe(diskError)
    expect(onDurableImport).not.toHaveBeenCalled()
    await expect(importOrcadMigrationCatalogDurably(args)).resolves.toBe(replayed)
    expect(onDurableImport).toHaveBeenCalledOnce()
    expect(importCatalog).toHaveBeenCalledTimes(2)
    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('does not acknowledge staging until its dormant manifest is durable', async () => {
    const diskError = new Error('disk full')
    const staged = { state: 'staged' } as OrcadMigrationCatalogState
    const stage = vi.fn().mockReturnValue(staged)
    const flush = vi.fn().mockRejectedValueOnce(diskError).mockResolvedValueOnce(undefined)
    const args = {
      store: {
        stageOrcadMigrationCatalog: stage,
        flushPendingOrThrowAsync: flush
      },
      manifest: {} as OrcadMigrationManifest
    }

    await expect(stageOrcadMigrationCatalogDurably(args)).rejects.toBe(diskError)
    await expect(stageOrcadMigrationCatalogDurably(args)).resolves.toBe(staged)
    expect(stage).toHaveBeenCalledTimes(2)
    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('publishes a committed catalog only after its receipt is durable', async () => {
    const diskError = new Error('disk full')
    const committed = { state: 'committed' } as OrcadMigrationCatalogState
    const commit = vi.fn().mockReturnValue(committed)
    const flush = vi.fn().mockRejectedValueOnce(diskError).mockResolvedValueOnce(undefined)
    const onDurableCommit = vi.fn()
    const args = {
      store: {
        commitStagedOrcadMigrationCatalog: commit,
        flushPendingOrThrowAsync: flush
      },
      manifest: {} as OrcadMigrationManifest,
      onDurableCommit
    }

    await expect(commitStagedOrcadMigrationCatalogDurably(args)).rejects.toBe(diskError)
    expect(onDurableCommit).not.toHaveBeenCalled()
    await expect(commitStagedOrcadMigrationCatalogDurably(args)).resolves.toBe(committed)
    expect(onDurableCommit).toHaveBeenCalledOnce()
  })

  it('reflushes an already-absent abort after the first flush failed', async () => {
    const aborted = { state: 'absent', aborted: true } as OrcadMigrationCatalogAbortResult
    const unchanged = { state: 'absent', aborted: false } as OrcadMigrationCatalogAbortResult
    const abort = vi.fn().mockReturnValueOnce(aborted).mockReturnValueOnce(unchanged)
    const flush = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined)
    const args = {
      store: {
        abortStagedOrcadMigrationCatalog: abort,
        flushPendingOrThrowAsync: flush
      },
      manifest: {} as OrcadMigrationManifest
    }

    await expect(abortStagedOrcadMigrationCatalogDurably(args)).rejects.toThrow('disk full')
    await expect(abortStagedOrcadMigrationCatalogDurably(args)).resolves.toEqual({
      ...unchanged,
      durableAbsent: true
    })
    expect(flush).toHaveBeenCalledTimes(2)
  })
})
