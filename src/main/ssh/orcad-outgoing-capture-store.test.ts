import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OrcadOutgoingCaptureStore } from './orcad-outgoing-capture-store'
import { createOrcadModelImportFixture } from '../orcad/orcad-model-import-test-fixture'
import {
  identity,
  preparation
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import * as secure from '../../shared/secure-file'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oc-outgoing-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const source = createOrcadModelImportFixture(root)
  const record = {
    version: 1,
    destinationEnvironmentId: 'paired-host',
    sourceSshTargetId: 'ssh-host',
    sourceSshTargetGeneration: 3,
    identity,
    source: source.store.loadDelegatedSource(identity),
    selection: source.selection,
    model: source.model,
    surfaceBinding: preparation.surfacePublication.surfaceBinding
  }
  const store = new OrcadOutgoingCaptureStore(root)
  const path = () =>
    join(root, 'orcad-outgoing-captures', readdirSync(join(root, 'orcad-outgoing-captures'))[0]!)
  return { store, record, path }
}

it('persists exact retry bytes across store reconstruction and reflushes identical retries', () => {
  const f = fixture()
  expect(f.store.read(identity)).toBeNull()
  const saved = f.store.persist(f.record)
  expect(new OrcadOutgoingCaptureStore(root).read(identity)).toEqual(saved)
  const write = vi.spyOn(secure, 'writeDurableSecureJsonFile')
  expect(f.store.persist(f.record)).toEqual(saved)
  expect(write).toHaveBeenCalledOnce()
  if (process.platform !== 'win32') {
    expect(statSync(f.path()).mode & 0o777).toBe(0o600)
  }
})

it.each(['environment', 'target', 'generation', 'credential', 'model'] as const)(
  'does not overwrite existing evidence with changed %s',
  (field) => {
    const f = fixture()
    f.store.persist(f.record)
    const bytes = readFileSync(f.path())
    const changes = {
      environment: { destinationEnvironmentId: 'other' },
      target: { sourceSshTargetId: 'other' },
      generation: { sourceSshTargetGeneration: 4 },
      credential: { source: { ...f.record.source!, endpointCredential: 'other' } },
      model: { model: { ...f.record.model, modelData: 'other' } }
    }
    expect(() => f.store.persist({ ...f.record, ...changes[field] })).toThrow()
    expect(readFileSync(f.path())).toEqual(bytes)
  }
)

it('refuses malformed saved evidence instead of replacing it', () => {
  const f = fixture()
  f.store.persist(f.record)
  writeFileSync(f.path(), '{broken')
  expect(() => f.store.persist(f.record)).toThrow()
  expect(readFileSync(f.path(), 'utf8')).toBe('{broken')
})

it('does not acknowledge uncertain permissions and reflushes after reconstruction', () => {
  const f = fixture()
  const original = secure.writeDurableSecureJsonFile
  const write = vi
    .spyOn(secure, 'writeDurableSecureJsonFile')
    .mockImplementationOnce((path, value) => {
      original(path, value)
      return false
    })
  expect(() => f.store.persist(f.record)).toThrow('permissions_unconfirmed')
  expect(new OrcadOutgoingCaptureStore(root).persist(f.record)).toEqual(f.store.read(identity))
  expect(write).toHaveBeenCalledTimes(2)
})

it('rejects another owner reusing the bridge key', () => {
  const f = fixture()
  f.store.persist(f.record)
  expect(() => f.store.read({ ...identity, ownerLease: 'other' })).toThrow('identity_mismatch')
})

it('discovers saved candidates after reconstruction without knowing their identities', () => {
  const f = fixture()
  expect(f.store.list()).toEqual([])
  const saved = f.store.persist(f.record)
  const write = vi.spyOn(secure, 'writeDurableSecureJsonFile')
  expect(new OrcadOutgoingCaptureStore(root).list()).toEqual([saved])
  expect(write).not.toHaveBeenCalled()
})

it('does not hide malformed candidates during discovery', () => {
  const f = fixture()
  f.store.persist(f.record)
  writeFileSync(f.path(), '{broken')
  expect(() => new OrcadOutgoingCaptureStore(root).list()).toThrow()
  expect(readFileSync(f.path(), 'utf8')).toBe('{broken')
})

it.each(['wrong.json', `${'0'.repeat(64)}.json`])(
  'refuses a candidate stored under the wrong filename %s',
  (name) => {
    const f = fixture()
    f.store.persist(f.record)
    renameSync(f.path(), join(root, 'orcad-outgoing-captures', name))
    expect(() => new OrcadOutgoingCaptureStore(root).list()).toThrow('filename_')
  }
)
