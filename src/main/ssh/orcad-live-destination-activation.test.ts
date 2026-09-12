import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as secure from '../../shared/secure-file'
import { prepareOrcadLiveSourceReleaseUnderAuthority } from './orcad-live-source-release-preparation'
import { OrcadLiveSourceReleaseIntentStore } from './orcad-live-source-release-intent'
import { terminalLayoutAdmissionFixture } from '../persistence/migrating-orcad-catalog/orcad-terminal-layout-admission-test-fixture'
import { receipt } from '../orcad-migration-source-cutover-test-fixture'
import { parseOrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import { inspectOrcadLiveDestinationActivations } from './orcad-live-destination-activation'
const commit = vi.hoisted(() => vi.fn())
vi.mock('./orcad-live-destination-commit', () => ({ commitOrcadLiveDestination: commit }))
let root: string
beforeEach(() => {
  commit.mockReset()
  root = mkdtempSync(join(tmpdir(), 'orca-live-release-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const { manifest, bindings } = terminalLayoutAdmissionFixture('folder')
  const cutover = parseOrcadMigrationSourceCutover({
    version: 2,
    phase: 'destination-committed',
    destinationEnvironmentId: 'environment',
    manifest,
    startedAt: manifest.createdAt,
    updatedAt: manifest.createdAt,
    receipt: receipt(manifest),
    liveTerminalBindings: bindings,
    terminalPublications: bindings.map(({ identity, surfaceBinding }, index) => ({
      identity,
      catalog: { migrationId: manifest.migrationId, manifestSha256: manifest.manifestSha256 },
      publicationReceipt: {
        version: 1,
        publicationReceiptId: `publication-${index}`,
        bridgeId: identity.bridgeId,
        destinationRuntimeId: identity.destinationRuntimeId,
        surfaceBinding,
        publishedAt: manifest.createdAt,
        commitReceipt: {
          bridgeId: identity.bridgeId,
          receiptId: `commit-${index}`,
          acceptedSourceEndSeq: 1,
          committedAt: manifest.createdAt
        }
      }
    }))
  })
  commit.mockResolvedValue(cutover)
  const controller = new AbortController()
  const authority = vi.fn()
  const read = vi.fn(() => cutover)
  const response = (
    request: Parameters<
      NonNullable<Parameters<typeof inspectOrcadLiveDestinationActivations>[0]['activate']>
    >[0]['request']
  ) => ({
    version: 1,
    identity: request.identity,
    publicationReceipt: request.publicationReceipt,
    destinationClaim: { generation: 1, claimId: 'claim' },
    catalog: { migrationId: manifest.migrationId, manifestSha256: manifest.manifestSha256 }
  })
  const activate = vi.fn(async ({ request }) => response(request))
  const options = {
    cutover,
    signal: controller.signal,
    assertAuthority: authority,
    activate,
    profileDirectory: root,
    pairingCode: 'pinned-pairing',
    sourceAdmission: { assertBindings: vi.fn(), projectSourceState: vi.fn() },
    store: {
      getOrcadMigrationSourceCutover: read,
      inspectOrcadMigrationSourceDependencies: () => ({ totalCount: 0 })
    }
  }
  const run = () =>
    inspectOrcadLiveDestinationActivations(
      options as unknown as Parameters<typeof inspectOrcadLiveDestinationActivations>[0]
    )
  const prepare = () =>
    prepareOrcadLiveSourceReleaseUnderAuthority(
      options as unknown as Parameters<typeof prepareOrcadLiveSourceReleaseUnderAuthority>[0]
    )
  return { cutover, options, activate, authority, controller, read, response, run, prepare }
}

it('reflushes committed catalog then inspects every terminal with its original grouped admission', async () => {
  const f = fixture()
  const result = await f.run()
  expect(result.activations).toHaveLength(2)
  expect(commit).toHaveBeenCalledOnce()
  expect(commit.mock.invocationCallOrder[0]).toBeLessThan(f.activate.mock.invocationCallOrder[0])
  for (const [options] of f.activate.mock.calls) {
    expect(options.request.catalogAdmission.bindings).toHaveLength(2)
    expect(options.pairingCode).toBe('pinned-pairing')
  }
  expect(result.cutover).toEqual(f.cutover)
})

it('does not inspect activation when durable commit acknowledgment fails', async () => {
  const f = fixture()
  commit.mockRejectedValue(new Error('destination flush failed'))
  await expect(f.run()).rejects.toThrow('destination flush failed')
  expect(f.activate).not.toHaveBeenCalled()
})

it('does not return a partial cohort when a later terminal is unverifiable', async () => {
  const f = fixture()
  f.activate
    .mockImplementationOnce(async ({ request }) => f.response(request))
    .mockRejectedValueOnce(new Error('source unverifiable'))
  await expect(f.run()).rejects.toThrow('source unverifiable')
  expect(f.activate).toHaveBeenCalledTimes(2)
  expect(f.read()).toEqual(f.cutover)
})

it.each(['authority', 'cancel', 'receipt'])(
  'refuses %s changes while activation is in flight',
  async (change) => {
    const f = fixture()
    f.activate.mockImplementationOnce(async ({ request }) => {
      const result = f.response(request)
      if (change === 'authority') {
        f.authority.mockImplementation(() => {
          throw new Error('source changed')
        })
      }
      if (change === 'cancel') {
        f.controller.abort(new Error('canceled'))
      }
      if (change === 'receipt') {
        result.publicationReceipt = null
      }
      return result
    })
    await expect(f.run()).rejects.toThrow()
    expect(f.activate).toHaveBeenCalledOnce()
  }
)

it('retains complete release intent independently of profile rewrites and reflushes exact retries', async () => {
  const f = fixture()
  const first = await f.prepare()
  writeFileSync(join(root, 'orca-data.json'), '{}')
  expect(new OrcadLiveSourceReleaseIntentStore(root).list()).toEqual([first.intent])
  const write = vi.spyOn(secure, 'writeDurableSecureJsonFile')
  expect(await f.prepare()).toEqual(first)
  expect(write).toHaveBeenCalledOnce()
  expect(f.activate).toHaveBeenCalledTimes(4)
})

it('retains historical claims but requires fresh nonregressing claims after reconnect', async () => {
  const f = fixture()
  const first = await f.prepare()
  f.activate.mockImplementation(async ({ request }) => ({
    ...f.response(request),
    destinationClaim: { generation: 2, claimId: 'reconnected' }
  }))
  const next = await f.prepare()
  expect(next.intent).toEqual(first.intent)
  expect(next.activations.every((entry) => entry.destinationClaim.generation === 2)).toBe(true)
  f.activate.mockImplementation(async ({ request }) => ({
    ...f.response(request),
    destinationClaim: { generation: 1, claimId: 'conflicting-claim' }
  }))
  await expect(f.prepare()).rejects.toThrow('activation_regressed')
})

it('never uses saved activation instead of contacting an unavailable destination', async () => {
  const f = fixture()
  const saved = await f.prepare()
  f.activate.mockRejectedValue(new Error('unverifiable'))
  await expect(f.prepare()).rejects.toThrow('unverifiable')
  expect(new OrcadLiveSourceReleaseIntentStore(root).list()).toEqual([saved.intent])
})

it('refuses acknowledgment after an uncertain write and reflushes it on retry', async () => {
  const f = fixture()
  const original = secure.writeDurableSecureJsonFile
  vi.spyOn(secure, 'writeDurableSecureJsonFile').mockImplementationOnce((path, value) => {
    original(path, value)
    return false
  })
  await expect(f.prepare()).rejects.toThrow('permissions_unconfirmed')
  const records = new OrcadLiveSourceReleaseIntentStore(root).list()
  expect(records).toHaveLength(1)
  expect((await f.prepare()).intent).toEqual(records[0])
})

it('retains evidence but refuses acknowledgment if authority changes during persistence', async () => {
  const f = fixture()
  const original = secure.writeDurableSecureJsonFile
  vi.spyOn(secure, 'writeDurableSecureJsonFile').mockImplementationOnce((path, value) => {
    const result = original(path, value)
    f.authority.mockImplementation(() => {
      throw new Error('source authority changed')
    })
    return result
  })
  await expect(f.prepare()).rejects.toThrow('source authority changed')
  expect(new OrcadLiveSourceReleaseIntentStore(root).list()).toHaveLength(1)
})

it('does not persist partial activation coverage', async () => {
  const f = fixture()
  f.activate
    .mockImplementationOnce(async ({ request }) => f.response(request))
    .mockRejectedValueOnce(new Error('second source unavailable'))
  await expect(f.prepare()).rejects.toThrow('second source unavailable')
  expect(new OrcadLiveSourceReleaseIntentStore(root).list()).toEqual([])
})

it('rejects incomplete retained activation records without replacing durable intent', async () => {
  const f = fixture()
  const saved = await f.prepare()
  const store = new OrcadLiveSourceReleaseIntentStore(root)
  expect(() =>
    store.persist({ ...saved.intent, activations: [saved.intent.activations[0]] })
  ).toThrow('incomplete')
  expect(() =>
    store.persist({
      ...saved.intent,
      activations: [saved.intent.activations[0], saved.intent.activations[0]]
    })
  ).toThrow('incomplete')
  expect(store.list()).toEqual([saved.intent])
})
