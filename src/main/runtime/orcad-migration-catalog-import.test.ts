import { describe, expect, it, vi } from 'vitest'
import type {
  OrcadMigrationCatalogAbortResult,
  OrcadMigrationCatalogReferenceAbortResult,
  OrcadMigrationCatalogState,
  OrcadMigrationManifest
} from '../../shared/orcad-migration/orcad-migration-manifest'
import {
  abortStagedOrcadMigrationCatalogByReferenceDurably,
  abortStagedOrcadMigrationCatalogDurably,
  commitStagedOrcadMigrationCatalogDurably,
  stageOrcadMigrationCatalogDurably
} from './orcad-migration-catalog-import'

describe('durable orcad migration catalog import', () => {
  it('does not acknowledge staging until its dormant manifest is durable', async () => {
    const diskError = new Error('disk full')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the durable wrappers only pass these values through to the stubbed store.
    const staged = { state: 'staged' } as OrcadMigrationCatalogState
    const stage = vi.fn().mockReturnValue(staged)
    const flush = vi.fn().mockRejectedValueOnce(diskError).mockResolvedValueOnce(undefined)
    const args = {
      store: {
        stageOrcadMigrationCatalog: stage,
        flushPendingOrThrowAsync: flush
      },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the durable wrappers only pass these values through to the stubbed store.
      manifest: {} as OrcadMigrationManifest
    }

    await expect(stageOrcadMigrationCatalogDurably(args)).rejects.toBe(diskError)
    await expect(stageOrcadMigrationCatalogDurably(args)).resolves.toBe(staged)
    expect(stage).toHaveBeenCalledTimes(2)
    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('publishes a committed catalog only after its receipt is durable', async () => {
    const diskError = new Error('disk full')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the durable wrappers only pass these values through to the stubbed store.
    const committed = { state: 'committed' } as OrcadMigrationCatalogState
    const commit = vi.fn().mockReturnValue(committed)
    const flush = vi.fn().mockRejectedValueOnce(diskError).mockResolvedValueOnce(undefined)
    const onDurableCommit = vi.fn()
    const args = {
      store: {
        commitStagedOrcadMigrationCatalog: commit,
        flushPendingOrThrowAsync: flush
      },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the durable wrappers only pass these values through to the stubbed store.
      manifest: {} as OrcadMigrationManifest,
      onDurableCommit
    }

    await expect(commitStagedOrcadMigrationCatalogDurably(args)).rejects.toBe(diskError)
    expect(onDurableCommit).not.toHaveBeenCalled()
    await expect(commitStagedOrcadMigrationCatalogDurably(args)).resolves.toBe(committed)
    expect(onDurableCommit).toHaveBeenCalledOnce()
  })

  it('reflushes an already-absent abort after the first flush failed', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the durable wrappers only pass these values through to the stubbed store.
    const aborted = { state: 'absent', aborted: true } as OrcadMigrationCatalogAbortResult
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the durable wrappers only pass these values through to the stubbed store.
    const unchanged = { state: 'absent', aborted: false } as OrcadMigrationCatalogAbortResult
    const abort = vi.fn().mockReturnValueOnce(aborted).mockReturnValueOnce(unchanged)
    const flush = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined)
    const args = {
      store: {
        abortStagedOrcadMigrationCatalog: abort,
        flushPendingOrThrowAsync: flush
      },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the durable wrappers only pass these values through to the stubbed store.
      manifest: {} as OrcadMigrationManifest
    }

    await expect(abortStagedOrcadMigrationCatalogDurably(args)).rejects.toThrow('disk full')
    await expect(abortStagedOrcadMigrationCatalogDurably(args)).resolves.toEqual({
      ...unchanged,
      durableAbsent: true
    })
    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('answers an abort by reference absent only once its flush succeeds', async () => {
    const reference = { migrationId: 'migration-1', manifestSha256: 'a'.repeat(64) }
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
})
