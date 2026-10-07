import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { MAX_ORCAD_MIGRATION_IMPORT_RECEIPTS } from '../../../shared/orcad-migration-manifest'
import { manifest } from '../../persistence-orcad-migration-catalog-fixture'
import {
  expireOrcadMigrationStages,
  findOrcadMigrationImportReceipt,
  ORCAD_MIGRATION_STAGE_TTL_MS,
  recordOrcadMigrationImportReceipt
} from './orcad-catalog-receipt-ledger'

const empty = { repositories: [], projectGroups: [], folderWorkspaces: [] }

function receiptFor(migrationId: string) {
  const input = manifest({ migrationId, payload: empty })
  return {
    input,
    receipt: {
      version: input.version,
      migrationId,
      manifestSha256: input.manifestSha256,
      source: input.source,
      importedAt: '2026-10-01T00:00:00.000Z',
      repositoryIds: [],
      projectGroupIds: [],
      folderWorkspaceIds: []
    }
  }
}

describe('orcad migration receipt ledger', () => {
  it('keeps answering for a commit whose receipt aged out of the bounded list', () => {
    const state = getDefaultPersistedState('/tmp/orcad-receipt-ledger')
    const first = receiptFor('migration-0')
    recordOrcadMigrationImportReceipt(state, first.receipt)
    for (let index = 1; index <= MAX_ORCAD_MIGRATION_IMPORT_RECEIPTS; index++) {
      recordOrcadMigrationImportReceipt(state, receiptFor(`migration-${index}`).receipt)
    }
    expect(state.orcadMigrationImportReceipts).toHaveLength(MAX_ORCAD_MIGRATION_IMPORT_RECEIPTS)
    expect(findOrcadMigrationImportReceipt(state, first.input)).toEqual(first.receipt)
    expect(findOrcadMigrationImportReceipt(state, receiptFor('never').input)).toBeUndefined()
  })

  it('expires a stage no client came back for', () => {
    const state = getDefaultPersistedState('/tmp/orcad-receipt-ledger')
    const stagedAt = '2026-10-01T00:00:00.000Z'
    state.orcadMigrationStagedCatalogs = [{ version: 1, manifest: manifest(), stagedAt }]
    const start = Date.parse(stagedAt)
    expect(expireOrcadMigrationStages(state, start + ORCAD_MIGRATION_STAGE_TTL_MS - 1)).toBe(false)
    expect(expireOrcadMigrationStages(state, start + ORCAD_MIGRATION_STAGE_TTL_MS)).toBe(true)
    expect(state.orcadMigrationStagedCatalogs).toEqual([])
  })
})
