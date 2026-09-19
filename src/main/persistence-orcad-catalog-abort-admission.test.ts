import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore, dataFile, testState } from './persistence-test-harness'
import {
  sealAdmissionManifest,
  terminalLayoutAdmissionFixture
} from './persistence/migrating-orcad-catalog/orcad-terminal-layout-admission-test-fixture'
import { PtyOwnershipTransferDestinationFileStore } from './persistence/pty-ownership-transfer/pty-ownership-transfer-destination-file-store'
import { ptyOwnershipTransferDestinationDirectory } from './persistence/pty-ownership-transfer/pty-ownership-transfer-destination-file-store-contract'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-catalog-abort-'))
})
afterEach(() => rmSync(testState.dir, { recursive: true, force: true }))

function destination(admission = terminalLayoutAdmissionFixture().admission) {
  const directory = ptyOwnershipTransferDestinationDirectory(testState.dir)
  const store = new PtyOwnershipTransferDestinationFileStore({ directory })
  const { identity } = admission.bindings[0]
  store.prepare(identity, 0)
  store.bindDelegatedSource(identity, {
    version: 1,
    proof: { ...identity, version: 1, credential: 'a'.repeat(64) },
    endpoint: '/source.sock',
    incumbentVersion: 'test',
    endpointCredential: 'test'
  })
  store.surface.bindCatalogAdmission(identity, admission)
  const file = join(
    directory,
    `${createHash('sha256').update(identity.bridgeId).digest('hex')}.json`
  )
  return { store, identity, file }
}

describe('catalog abort admission against durable destination transfers', () => {
  it('retains uploaded recovery bytes after refusal and reload', async () => {
    const fixture = terminalLayoutAdmissionFixture()
    const bytes = Buffer.from('preserved recovery history')
    const { tabId, leafId } = fixture.bindings[0].surfaceBinding
    const ref = `v1-${'1'.repeat(32)}`
    const draft = structuredClone(fixture.manifest)
    const dormant = draft.payload.dormantState!
    dormant.workspaceSession!.terminalLayoutsByTabId[tabId].scrollbackRefsByLeafId = {
      [leafId]: ref
    }
    dormant.terminalScrollbackSnapshots = [
      {
        tabId,
        leafId,
        ref,
        byteLength: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex')
      }
    ]
    const manifest = sealAdmissionManifest(draft)
    const catalog = createStore()
    catalog.stageOrcadMigrationCatalog(manifest)
    const request = {
      migrationId: manifest.migrationId,
      manifestSha256: manifest.manifestSha256,
      ref,
      offset: 0,
      bytesBase64: bytes.toString('base64')
    }
    catalog.stageOrcadMigrationSnapshotChunk(request)
    await catalog.flushPendingOrThrowAsync()
    const { store, identity } = destination({ ...fixture.admission, manifest })
    expect(() => catalog.abortStagedOrcadMigrationCatalog(manifest)).toThrow(
      'orcad_migration_catalog_abort_transfer_active'
    )
    const restored = createStore()
    expect(restored.getOrcadMigrationCatalogState(manifest)).toMatchObject({
      state: 'staged',
      snapshotUploads: [{ ref, receivedBytes: bytes.length }]
    })
    expect(() =>
      restored.stageOrcadMigrationSnapshotChunk({
        ...request,
        bytesBase64: Buffer.alloc(bytes.length, 'x').toString('base64')
      })
    ).toThrow('orcad_migration_snapshot_retry_mismatch')
    expect(() => restored.stageOrcadMigrationSnapshotChunk(request)).not.toThrow()
    store.abort(identity)
    expect(restored.abortStagedOrcadMigrationCatalog(manifest).aborted).toBe(true)
    restored.stageOrcadMigrationCatalog(manifest)
    expect(restored.getOrcadMigrationCatalogState(manifest)).toMatchObject({
      snapshotUploads: [{ ref, receivedBytes: 0 }]
    })
    await restored.flushPendingOrThrowAsync()
  })

  it.each(['prepared', 'committed', 'claimed'] as const)(
    'preserves the staged catalog and journal for a %s transfer, including after reload',
    async (phase) => {
      const { manifest } = terminalLayoutAdmissionFixture()
      const catalog = createStore()
      catalog.stageOrcadMigrationCatalog(manifest)
      await catalog.flushPendingOrThrowAsync()
      const { store, identity, file } = destination()
      if (phase === 'claimed') {
        store.reserveDelegatedClaimIntent(identity, null, {
          version: 1,
          previousClaim: null,
          claim: { generation: 1, claimId: 'claim' }
        })
      }
      if (phase !== 'prepared') {
        store.commit(identity, {
          bridgeId: identity.bridgeId,
          receiptId: 'receipt',
          acceptedSourceEndSeq: 0,
          committedAt: '2026-09-06T00:00:00.000Z'
        })
      }
      const journal = readFileSync(file, 'utf8')
      for (const current of [catalog, createStore()]) {
        await current.flushPendingOrThrowAsync()
        const before = readFileSync(dataFile(), 'utf8')
        expect(() => current.abortStagedOrcadMigrationCatalog(manifest)).toThrow(
          'orcad_migration_catalog_abort_transfer_active'
        )
        expect(current.getOrcadMigrationCatalogState(manifest).state).toBe('staged')
        await current.flushPendingOrThrowAsync()
        expect(readFileSync(dataFile(), 'utf8')).toBe(before)
        expect(readFileSync(file, 'utf8')).toBe(journal)
      }
    }
  )

  it('rechecks current journals and permits abort only after explicit destination abort', async () => {
    const { manifest } = terminalLayoutAdmissionFixture()
    const catalog = createStore()
    catalog.stageOrcadMigrationCatalog(manifest)
    await catalog.flushPendingOrThrowAsync()
    const restored = createStore()
    const { store, identity, file } = destination()
    expect(() => restored.abortStagedOrcadMigrationCatalog(manifest)).toThrow(
      'orcad_migration_catalog_abort_transfer_active'
    )
    store.abort(identity)
    const journal = readFileSync(file, 'utf8')
    expect(restored.abortStagedOrcadMigrationCatalog(manifest).aborted).toBe(true)
    await restored.flushPendingOrThrowAsync()
    expect(createStore().getOrcadMigrationCatalogState(manifest).state).toBe('absent')
    expect(readFileSync(file, 'utf8')).toBe(journal)
  })

  it.each(['corrupt', 'unknown-version', 'wrong-filename', 'digest-conflict'])(
    'refuses %s evidence without deleting the stage',
    async (kind) => {
      const { manifest, admission } = terminalLayoutAdmissionFixture()
      const catalog = createStore()
      catalog.stageOrcadMigrationCatalog(manifest)
      await catalog.flushPendingOrThrowAsync()
      const { file, store, identity } = destination(
        kind === 'digest-conflict'
          ? {
              ...admission,
              manifest: sealAdmissionManifest({
                ...manifest,
                createdAt: '2026-09-05T00:00:00.000Z'
              })
            }
          : admission
      )
      if (kind === 'wrong-filename') {
        store.abort(identity)
      }
      const record = JSON.parse(readFileSync(file, 'utf8'))
      if (kind === 'corrupt') {
        writeFileSync(file, '{')
      } else if (kind === 'unknown-version') {
        writeFileSync(file, JSON.stringify({ ...record, version: 999 }))
      } else if (kind === 'wrong-filename') {
        writeFileSync(
          join(ptyOwnershipTransferDestinationDirectory(testState.dir), `${'f'.repeat(64)}.json`),
          JSON.stringify(record)
        )
      }
      expect(() => catalog.abortStagedOrcadMigrationCatalog(manifest)).toThrow(
        kind === 'digest-conflict'
          ? 'orcad_migration_catalog_abort_manifest_conflict'
          : 'orcad_migration_catalog_abort_unverifiable'
      )
      expect(catalog.getOrcadMigrationCatalogState(manifest).state).toBe('staged')
    }
  )

  it.each(['no-transfers', 'unrelated-transfer'])('allows dormant cancellation with %s', (kind) => {
    const { manifest, admission } = terminalLayoutAdmissionFixture()
    const catalog = createStore()
    catalog.stageOrcadMigrationCatalog(manifest)
    if (kind === 'unrelated-transfer') {
      destination({
        ...admission,
        manifest: sealAdmissionManifest({ ...manifest, migrationId: 'other' })
      })
    }
    expect(catalog.abortStagedOrcadMigrationCatalog(manifest).aborted).toBe(true)
  })

  it.each(['absent', 'committed'])('keeps %s catalog cancellation a no-op', (state) => {
    const { manifest } = terminalLayoutAdmissionFixture()
    const catalog = createStore()
    if (state === 'committed') {
      catalog.importOrcadMigrationCatalog(manifest)
    }
    const { file } = destination()
    writeFileSync(file, '{')
    expect(catalog.abortStagedOrcadMigrationCatalog(manifest)).toMatchObject({
      state,
      aborted: false
    })
  })
})
