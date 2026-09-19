import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { liveSourceRetirementFixture } from '../persistence/migrating-orcad-catalog/orcad-live-source-retirement-test-fixture'
import {
  createOrcadLiveSourceRetirementRecord,
  OrcadLiveSourceRetirementRecordStore
} from './orcad-live-source-retirement-record'
import {
  createOrcadLiveSourceCleanupIntent,
  OrcadLiveSourceCleanupIntentStore
} from './orcad-live-source-cleanup-intent'
import {
  createOrcadLiveCleanupOutputEvidence,
  listValidatedOrcadLiveCleanupOutputEvidence,
  OrcadLiveCleanupOutputEvidenceStore,
  parseOrcadLiveCleanupOutputEvidence
} from './orcad-live-cleanup-output-evidence'
import { restoreOutgoingOrcadPreparationAdmission } from './orcad-outgoing-preparation-startup'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-cleanup-output-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const f = liveSourceRetirementFixture()
  const record = createOrcadLiveSourceRetirementRecord({
    ...f,
    release: {
      version: 1,
      cutover: f.cutover,
      activations: f.cutover.terminalPublications!.map((publication) => ({
        version: 1,
        identity: publication.identity,
        publicationReceipt: publication.publicationReceipt,
        destinationClaim: { generation: 1, claimId: 'claim' },
        catalog: publication.catalog
      }))
    }
  })
  const settlements = record.release.cutover.liveTerminalBindings!.map(({ identity }, index) => ({
    id: identity.terminalId,
    ptyIncarnation: identity.incarnationId,
    ownerGeneration: identity.sourceOwnerGeneration,
    providerGeneration: 1,
    clientGeneration: 1,
    deliveryToken: `token-${index}`,
    fromSourceEndSu: 100,
    throughSourceEndSu: 104
  }))
  new OrcadLiveSourceRetirementRecordStore(root).persist(record)
  new OrcadLiveSourceCleanupIntentStore(root).persist(createOrcadLiveSourceCleanupIntent(record))
  return { record, settlements, store: new OrcadLiveCleanupOutputEvidenceStore(root) }
}

it('durably joins exact local ranges to the retirement cohort without asserting earlier history', () => {
  const f = fixture()
  const evidence = createOrcadLiveCleanupOutputEvidence(f.record, f.settlements.toReversed())
  expect(evidence.settlements).toEqual(f.settlements)
  f.store.persist(evidence)
  expect(listValidatedOrcadLiveCleanupOutputEvidence(root)).toEqual([
    { evidence, record: f.record }
  ])
  expect(new OrcadLiveCleanupOutputEvidenceStore(root).read(f.record.identity)).toEqual(evidence)
  expect(evidence.settlements[0].fromSourceEndSu).toBe(100)
})

it.each(['missing', 'extra', 'incarnation', 'owner', 'duplicate'] as const)(
  'refuses a %s settlement cohort mismatch',
  (kind) => {
    const f = fixture()
    const values = structuredClone(f.settlements)
    if (kind === 'missing') {
      values.pop()
    }
    if (kind === 'extra') {
      values.push({ ...values[0], id: 'foreign' })
    }
    if (kind === 'incarnation') {
      values[0].ptyIncarnation = 'replacement'
    }
    if (kind === 'owner') {
      values[0].ownerGeneration++
    }
    if (kind === 'duplicate') {
      values.push(values[0])
    }
    expect(() => createOrcadLiveCleanupOutputEvidence(f.record, values)).toThrow()
  }
)

it.each(['negative', 'fractional', 'reversed', 'unsafe', 'generation', 'token'] as const)(
  'refuses %s local range evidence',
  (kind) => {
    const f = fixture()
    const evidence = createOrcadLiveCleanupOutputEvidence(f.record, f.settlements)
    const first = evidence.settlements[0]
    if (kind === 'negative') {
      first.fromSourceEndSu = -1
    }
    if (kind === 'fractional') {
      first.throughSourceEndSu = 104.5
    }
    if (kind === 'reversed') {
      first.throughSourceEndSu = 99
    }
    if (kind === 'unsafe') {
      first.throughSourceEndSu = Number.MAX_SAFE_INTEGER + 1
    }
    if (kind === 'generation') {
      first.providerGeneration = 0
    }
    if (kind === 'token') {
      first.deliveryToken = ''
    }
    expect(() => parseOrcadLiveCleanupOutputEvidence(evidence)).toThrow()
  }
)

it('rejects changed saved ranges instead of replacing historical settlement', () => {
  const f = fixture()
  f.store.persist(createOrcadLiveCleanupOutputEvidence(f.record, f.settlements))
  f.settlements[0].throughSourceEndSu++
  expect(() =>
    f.store.persist(createOrcadLiveCleanupOutputEvidence(f.record, f.settlements))
  ).toThrow('conflict')
})

it('refuses orphan output evidence before provider startup', async () => {
  const f = fixture()
  const evidence = createOrcadLiveCleanupOutputEvidence(f.record, f.settlements)
  f.store.persist({ ...evidence, retirementRecordSha256: 'f'.repeat(64) })
  const mux = {
    fencePtyControlsAndDrain: vi.fn(async () => {}),
    fencePtyPreparationSurface: vi.fn(),
    fencePtyCatalogCreation: vi.fn()
  }
  expect(() => listValidatedOrcadLiveCleanupOutputEvidence(root)).toThrow('conflict')
  await expect(restoreOutgoingOrcadPreparationAdmission('target', mux, root)).rejects.toThrow(
    'conflict'
  )
  expect(mux.fencePtyControlsAndDrain).not.toHaveBeenCalled()
})
