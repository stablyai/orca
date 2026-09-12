import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OrcadLiveCutoverIntentStore } from './orcad-live-cutover-intent-store'
import { terminalLayoutAdmissionFixture } from '../persistence/migrating-orcad-catalog/orcad-terminal-layout-admission-test-fixture'
import * as secure from '../../shared/secure-file'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-live-intent-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const { manifest, bindings } = terminalLayoutAdmissionFixture('folder')
  const record = {
    version: 2,
    phase: 'source-fenced',
    destinationEnvironmentId: 'environment',
    manifest,
    liveTerminalBindings: bindings,
    startedAt: manifest.createdAt,
    updatedAt: manifest.createdAt
  }
  const store = new OrcadLiveCutoverIntentStore(root)
  const path = () =>
    join(
      root,
      'orcad-live-cutover-intents',
      readdirSync(join(root, 'orcad-live-cutover-intents'))[0]
    )
  return { record, store, path }
}

it('retains exact authority independently of a legacy profile rewrite and reflushes retries', () => {
  const f = fixture()
  const saved = f.store.persist(f.record)
  writeFileSync(join(root, 'orca-data.json'), JSON.stringify({ orcadMigrationSourceCutovers: [] }))
  expect(new OrcadLiveCutoverIntentStore(root).list()).toEqual([saved])
  const write = vi.spyOn(secure, 'writeDurableSecureJsonFile')
  expect(new OrcadLiveCutoverIntentStore(root).persist(f.record)).toEqual(saved)
  expect(write).toHaveBeenCalledOnce()
})

it.each(['destination', 'lease', 'bridge', 'digest', 'phase', 'identity'] as const)(
  'refuses changed %s without replacing retained authority',
  (change) => {
    const f = fixture()
    const saved = f.store.persist(f.record)
    const changed = structuredClone(f.record)
    if (change === 'destination') {
      changed.destinationEnvironmentId = 'other'
    } else if (change === 'lease') {
      Object.assign(changed.liveTerminalBindings[1].identity, { ownerLease: 'other' })
    } else if (change === 'bridge') {
      Object.assign(changed.liveTerminalBindings[0].identity, { bridgeId: 'other' })
    } else if (change === 'digest') {
      changed.manifest.manifestSha256 = '0'.repeat(64)
    } else if (change === 'phase') {
      changed.phase = 'destination-staged'
    } else {
      Object.assign(changed, { identity: { ...saved.identity, bridgeId: 'other' } })
    }
    const before = readFileSync(f.path())
    expect(() => f.store.persist(changed)).toThrow()
    expect(readFileSync(f.path())).toEqual(before)
    expect(f.store.list()).toEqual([saved])
  }
)

it('preserves uncertain writes and requires a successful durable reflush after reconstruction', () => {
  const f = fixture()
  const original = secure.writeDurableSecureJsonFile
  vi.spyOn(secure, 'writeDurableSecureJsonFile').mockImplementationOnce((path, value) => {
    original(path, value)
    return false
  })
  expect(() => f.store.persist(f.record)).toThrow('permissions_unconfirmed')
  expect(new OrcadLiveCutoverIntentStore(root).persist(f.record)).toEqual(f.store.list()[0])
})

it('refuses malformed retained evidence instead of hiding or replacing it', () => {
  const f = fixture()
  f.store.persist(f.record)
  writeFileSync(f.path(), '{broken')
  expect(() => f.store.persist(f.record)).toThrow()
  expect(readFileSync(f.path(), 'utf8')).toBe('{broken')
})

it.each([false, 1, 'true', null])(
  'refuses invalid participation enrollment marker %s',
  (marker) => {
    const f = fixture()
    expect(() => f.store.persist({ ...f.record, profileParticipationRequired: marker })).toThrow(
      'marker_invalid'
    )
    expect(f.store.list()).toEqual([])
  }
)
