import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createStore, testState } from '../../persistence-test-harness'
import { connectOrcadLocalRelay } from '../../orcad/orcad-local-relay-connection'
import {
  context,
  identity,
  preparation,
  request
} from '../../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import {
  terminalLayoutAdmissionFixture,
  sealAdmissionManifest
} from '../migrating-orcad-catalog/orcad-terminal-layout-admission-test-fixture'
import { parseOrcadTerminalLayoutAdmission } from '../migrating-orcad-catalog/orcad-terminal-layout-admission'
import { capturedPreparationFixture } from './pty-ownership-transfer-captured-preparation-test-fixture'
import { readCapturedPtyPublicationRetry } from './pty-ownership-transfer-captured-publication-retry'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../orcad/orcad-local-relay-connection', () => ({ connectOrcadLocalRelay: vi.fn() }))

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-captured-catalog-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(connectOrcadLocalRelay).mockReset()
  rmSync(testState.dir, { recursive: true, force: true })
})

function setup(catalogPublicationVersion?: 1) {
  const f = capturedPreparationFixture()
  const { manifest } = terminalLayoutAdmissionFixture('folder')
  const admission = parseOrcadTerminalLayoutAdmission({
    version: 1,
    manifest,
    bindings: [{ identity, surfaceBinding: preparation.surfacePublication.surfaceBinding }]
  })
  f.store.stageOrcadMigrationCatalog(manifest)
  f.store.flushOrThrow()
  const registry = f.reopen(f.store, catalogPublicationVersion)
  return { ...f, registry, manifest, admission, input: { ...f.input, catalogAdmission: admission } }
}

it('publishes through the real catalog-aware path, commits catalog and reopens exact retry evidence', async () => {
  const f = setup(1)
  expect(f.registry.supportsCapturedCatalogPublication()).toBe(true)
  const prepare = f.registry.prepareDelegated.bind(f.registry)
  const intake = vi.spyOn(f.registry, 'prepareDelegated').mockImplementation((result, source) => {
    expect(f.destinationStore.surface.loadCatalogAdmission(identity)).toEqual(f.admission)
    expect(f.destinationStore.load(identity)?.phase).toBe('prepared')
    return prepare(result, source)
  })
  const prepared = await f.registry.prepareCapturedDelegated(f.input)
  expect(intake).toHaveBeenCalledOnce()
  expect(prepared.snapshot.phase).toBe('published')
  expect(f.destinationStore.surface.loadCatalogAdmission(identity)).toEqual(f.admission)
  expect(f.store.getWorkspaceSession().terminalLayoutsByTabId['tab-1'].root).toEqual(
    f.manifest.payload.dormantState!.workspaceSession!.terminalLayoutsByTabId['tab-1'].root
  )
  expect(f.store.commitStagedOrcadMigrationCatalog(f.manifest).state).toBe('committed')
  f.store.flushOrThrow()
  const restored = createStore()
  expect(restored.getOrcadMigrationCatalogState(f.manifest).state).toBe('committed')
  const registry = f.reopen(restored, 1)
  registry.recoverPersistedDelegatedDestinations()
  const destination = registry.getPublishedDelegatedDestination(identity)
  f.rpc.mockClear()
  expect(readCapturedPtyPublicationRetry(f.input, destination).publicationReceipt).toEqual(
    prepared.publicationReceipt
  )
  expect(() =>
    readCapturedPtyPublicationRetry({ ...f.input, catalogAdmission: undefined }, destination)
  ).toThrow('retry_catalog_conflict')
  expect(f.rpc).not.toHaveBeenCalled()
})

it('refuses disabled catalog publication before contacting source or creating destination state', async () => {
  const f = setup()
  expect(f.registry.supportsCapturedCatalogPublication()).toBe(false)
  const intake = vi.spyOn(f.registry, 'prepareDelegated')
  const before = f.source.inspectDestination(request(), context())
  await expect(f.registry.prepareCapturedDelegated(f.input)).rejects.toThrow(
    'pty_ownership_transfer_catalog_publication_not_supported'
  )
  expect(intake).not.toHaveBeenCalled()
  expect(f.rpc).not.toHaveBeenCalled()
  expect(f.destinationStore.load(identity)).toBeNull()
  expect(f.source.inspectDestination(request(), context())).toEqual(before)
  expect(createStore().getWorkspaceSession().tabsByWorktree['folder:folder-1']).toBeUndefined()
  expect(f.sourceStore.loadAll()[0].history.frames).toEqual([
    { seq: 1, data: 'one🙂' },
    { seq: 2, data: 'later' }
  ])
})

it('withdraws opt-in support when destination admission closes', () => {
  const f = setup(1)
  expect(f.registry.supportsCapturedCatalogPublication()).toBe(true)
  f.registry.fenceAdmissionForDecommission()
  expect(f.registry.supportsCapturedCatalogPublication()).toBe(false)
})

it.each(['identity', 'surface'] as const)(
  'refuses an authenticated source with different catalog %s before intake',
  async (mode) => {
    const f = setup(1)
    const entry = f.input.catalogAdmission.bindings[0]
    f.input.catalogAdmission = parseOrcadTerminalLayoutAdmission({
      ...f.admission,
      bindings: [
        {
          identity:
            mode === 'identity' ? { ...entry.identity, ownerLease: 'other-lease' } : entry.identity,
          surfaceBinding:
            mode === 'surface'
              ? { ...entry.surfaceBinding, leafId: '22222222-2222-4222-8222-222222222222' }
              : entry.surfaceBinding
        }
      ]
    })
    const intake = vi.spyOn(f.registry, 'prepareDelegated')
    await expect(f.registry.prepareCapturedDelegated(f.input)).rejects.toThrow(
      'captured_catalog_source_conflict'
    )
    expect(f.rpc).toHaveBeenCalledOnce()
    expect(intake).not.toHaveBeenCalled()
    expect(f.destinationStore.load(identity)).toBeNull()
  }
)

it.each(['stage-mismatch', 'flush-failed'] as const)(
  'refuses %s before creating destination or importing model',
  async (mode) => {
    const f = setup(1)
    if (mode === 'stage-mismatch') {
      f.input.catalogAdmission = {
        ...f.admission,
        manifest: sealAdmissionManifest({ ...f.manifest, createdAt: '2026-09-07T00:00:00.000Z' })
      }
    } else {
      vi.spyOn(f.store, 'flushOrThrow').mockImplementationOnce(() => {
        throw new Error('injected-host-flush-failure')
      })
    }
    const before = f.source.inspectDestination(request(), context())
    const intake = vi.spyOn(f.registry, 'prepareDelegated')
    await expect(f.registry.prepareCapturedDelegated(f.input)).rejects.toThrow(
      mode === 'flush-failed' ? 'injected-host-flush-failure' : 'catalog_not_staged'
    )
    expect(f.rpc).toHaveBeenCalledOnce()
    expect(intake).not.toHaveBeenCalled()
    expect(f.destinationStore.load(identity)).toBeNull()
    expect(f.source.inspectDestination(request(), context())).toEqual(before)
  }
)
