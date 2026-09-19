import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  OrcadOutgoingCaptureStore,
  parseOrcadOutgoingSourceBinding
} from './orcad-outgoing-capture-store'
import { OrcadOutgoingPreparationStore } from './orcad-outgoing-preparation-store'
import { publishOutgoingOrcadCapture } from './orcad-outgoing-capture-publication'
import { createOrcadModelImportFixture } from '../orcad/orcad-model-import-test-fixture'
import { terminalLayoutAdmissionFixture } from '../persistence/migrating-orcad-catalog/orcad-terminal-layout-admission-test-fixture'
import {
  identity,
  preparation
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

const publish = vi.hoisted(() => vi.fn())
vi.mock('./orcad-captured-destination-client', () => ({
  prepareRemoteOrcadCapturedDestination: publish
}))
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oc-catalog-recovery-'))
  publish.mockReset().mockResolvedValue({ outcome: 'published' })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function fixture() {
  const source = createOrcadModelImportFixture(root)
  const surfaceBinding = preparation.surfacePublication.surfaceBinding
  const { manifest } = terminalLayoutAdmissionFixture('folder')
  const record = {
    version: 2,
    destinationEnvironmentId: 'paired-host',
    sourceSshTargetId: manifest.source.sshTargetId,
    sourceSshTargetGeneration: manifest.source.sshTargetGeneration!,
    identity,
    source: source.store.loadDelegatedSource(identity),
    selection: source.selection,
    model: source.model,
    surfaceBinding,
    catalogAdmission: { version: 1, manifest, bindings: [{ identity, surfaceBinding }] }
  }
  return { record, store: new OrcadOutgoingCaptureStore(root) }
}

it('retains identical catalog authority in preparation and capture across reconstruction', () => {
  const f = fixture()
  const intent = new OrcadOutgoingPreparationStore(root).persist({
    ...f.record,
    kind: 'preparation'
  })
  const saved = f.store.persist(f.record)
  expect(new OrcadOutgoingPreparationStore(root).read(identity)).toEqual(intent)
  expect(new OrcadOutgoingCaptureStore(root).list()).toEqual([saved])
  expect(parseOrcadOutgoingSourceBinding(saved)).toEqual(parseOrcadOutgoingSourceBinding(intent))
  expect(saved.catalogAdmission).toEqual(f.record.catalogAdmission)
  expect(saved.version).toBe(2)
})

it.each(['missing', 'legacy', 'identity', 'surface', 'source', 'generation'] as const)(
  'rejects %s catalog authority without replacing durable capture',
  (change) => {
    const f = fixture()
    const saved = f.store.persist(f.record)
    const changed = structuredClone(f.record)
    if (change === 'missing') {
      Reflect.deleteProperty(changed, 'catalogAdmission')
    }
    if (change === 'legacy') {
      changed.version = 1
    }
    if (change === 'identity') {
      changed.catalogAdmission.bindings[0].identity.ownerLease = 'other'
    }
    if (change === 'surface') {
      changed.surfaceBinding = { ...changed.surfaceBinding, tabId: 'other' }
    }
    if (change === 'source') {
      changed.sourceSshTargetId = 'other'
    }
    if (change === 'generation') {
      changed.sourceSshTargetGeneration++
    }
    expect(() => f.store.persist(changed)).toThrow()
    expect(new OrcadOutgoingCaptureStore(root).read(identity)).toEqual(saved)
  }
)

it('refuses replacement of catalog-required evidence with a valid legacy capture', () => {
  const f = fixture()
  const saved = f.store.persist(f.record)
  const { catalogAdmission: _catalog, ...legacy } = f.record
  expect(() => f.store.persist({ ...legacy, version: 1 })).toThrow('conflict')
  expect(f.store.read(identity)).toEqual(saved)
})

it('replays exact catalog authority after a lost publication reply and store reconstruction', async () => {
  const f = fixture()
  const saved = f.store.persist(f.record)
  const options = {
    ...saved,
    store: f.store,
    pairingCode: 'pairing',
    signal: new AbortController().signal,
    assertAuthority: vi.fn()
  }
  publish.mockRejectedValueOnce(new Error('reply lost'))
  await expect(publishOutgoingOrcadCapture(options)).rejects.toThrow('reply lost')
  await publishOutgoingOrcadCapture({ ...options, store: new OrcadOutgoingCaptureStore(root) })
  expect(publish.mock.calls[0]).toEqual(publish.mock.calls[1])
  expect(publish.mock.calls[1][0].capture.catalogAdmission).toEqual(saved.catalogAdmission)
  expect(f.store.read(identity)).toEqual(saved)
})
