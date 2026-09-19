import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  OrcadOutgoingPreparationStore,
  outgoingOrcadSourcePreparationRequest
} from './orcad-outgoing-preparation-store'
import { OrcadOutgoingCaptureStore } from './orcad-outgoing-capture-store'
import { OrcadOutgoingPreparationDrainReceiptStore } from './orcad-outgoing-preparation-drain-receipt'
import { OrcadOutgoingPreparationConnectionStore } from './orcad-outgoing-preparation-connection'
import { createOrcadModelImportFixture } from '../orcad/orcad-model-import-test-fixture'
import {
  identity,
  preparation,
  makeDelegatedRelay
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { RelayPtyOwnershipTransferFileStore } from '../../relay/relay-pty-ownership-transfer-file-store'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oc-prepare-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const source = createOrcadModelImportFixture(root)
  const value = {
    version: 1,
    kind: 'preparation',
    identity,
    destinationEnvironmentId: 'destination',
    sourceSshTargetId: 'source',
    sourceSshTargetGeneration: 1,
    source: source.store.loadDelegatedSource(identity),
    surfaceBinding: preparation.surfacePublication.surfaceBinding
  }
  return { value, store: new OrcadOutgoingPreparationStore(root) }
}

it('reconstructs preparation intent separately from model candidates and sends only a credential digest', () => {
  const f = fixture()
  expect(f.store.list()).toEqual([])
  const saved = f.store.persist(f.value)
  expect(new OrcadOutgoingPreparationStore(root).list()).toEqual([saved])
  expect(new OrcadOutgoingCaptureStore(root).list()).toEqual([])
  const request = outgoingOrcadSourcePreparationRequest(saved)
  expect(request).toEqual({
    version: 1,
    ...identity,
    surfacePublication: preparation.surfacePublication,
    destinationDelegation: {
      version: 1,
      credentialSha256: createHash('sha256').update(saved.source.proof.credential).digest('hex')
    }
  })
  expect(JSON.stringify(request)).not.toContain(saved.source.proof.credential)
  expect(JSON.stringify(request)).not.toContain(saved.source.endpointCredential)
})

it('retries the same source preparation after discarding its successful reply', () => {
  const f = fixture()
  const saved = f.store.persist(f.value)
  const sourceDirectory = join(root, 'prepared-source')
  const hostStore = new RelayPtyOwnershipTransferFileStore(sourceDirectory)
  makeDelegatedRelay(hostStore).prepare(outgoingOrcadSourcePreparationRequest(saved))
  const hostBefore = hostStore.loadAll()
  const recovered = new OrcadOutgoingPreparationStore(root).read(identity)!
  const restartedAdapter = makeDelegatedRelay(
    new RelayPtyOwnershipTransferFileStore(sourceDirectory)
  )
  expect(restartedAdapter.prepare(outgoingOrcadSourcePreparationRequest(recovered))).toMatchObject({
    ...identity,
    phase: 'prepared',
    destinationDelegation: preparation.destinationDelegation
  })
  expect(hostStore.loadAll()).toEqual(hostBefore)
  expect(f.store.read(identity)).toEqual(saved)
})

it('preserves the original credential when a conflicting retry tries to replace it', () => {
  const f = fixture()
  const saved = f.store.persist(f.value)
  expect(() =>
    f.store.persist({
      ...f.value,
      source: { ...saved.source, proof: { ...saved.source.proof, credential: '0'.repeat(64) } }
    })
  ).toThrow('conflict')
  expect(new OrcadOutgoingPreparationStore(root).read(identity)).toEqual(saved)
})

it('does not accept a capture candidate as a preparation intent', () => {
  const f = fixture()
  expect(() => f.store.persist({ ...f.value, kind: undefined })).toThrow('kind_invalid')
  expect(f.store.list()).toEqual([])
})

it('persists drain evidence against the exact intent and pinned connection without replacing either', () => {
  const f = fixture()
  const source = { provider: {}, providerGeneration: 7 }
  const intent = f.store.persistForSource(f.value, source)
  const binding = new OrcadOutgoingPreparationConnectionStore(root).read(identity)
  const receipt = f.store.persistSourceDrain(intent, source)
  expect(receipt).toEqual({ ...binding, kind: 'mux-control-drain', scope: 'bound-mux-lifetime' })
  expect(new OrcadOutgoingPreparationDrainReceiptStore(root).list()).toEqual([receipt])
  expect(f.store.read(identity)).toEqual(intent)
  expect(new OrcadOutgoingPreparationConnectionStore(root).read(identity)).toEqual(binding)
  expect(() => f.store.persistSourceDrain(intent, { ...source, provider: {} })).toThrow(
    'connection_reconciliation_required'
  )
  expect(() =>
    f.store.persistSourceDrain({ ...intent, destinationEnvironmentId: 'other' }, source)
  ).toThrow('connection_reconciliation_required')
  expect(new OrcadOutgoingPreparationDrainReceiptStore(root).read(identity)).toEqual(receipt)
})

it.each([
  { kind: 'prepared' },
  { scope: 'all-connections' },
  { scope: undefined },
  { version: 2 },
  { providerGeneration: 0 },
  { connectionId: 'other' },
  { preparationSha256: 'invalid' }
])('refuses invalid or overbroad drain evidence %j', (change) => {
  const f = fixture()
  const source = { provider: {}, providerGeneration: 1 }
  const intent = f.store.persistForSource(f.value, source)
  const receipt = f.store.persistSourceDrain(intent, source)
  const receipts = new OrcadOutgoingPreparationDrainReceiptStore(root)
  expect(() => receipts.persist({ ...receipt, ...change })).toThrow()
  expect(receipts.read(identity)).toEqual(receipt)
})
