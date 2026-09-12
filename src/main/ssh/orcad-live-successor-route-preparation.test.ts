import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appliedCoverageFixture } from './orcad-live-applied-coverage-test-fixture'
import type { withOrcadLiveSuccessorReadiness } from './orcad-live-successor-readiness'
import type {
  OrcadLiveSuccessorCompletionPreparationStore as PreparationStore,
  OrcadLiveSuccessorRouteCheckpointStore as CheckpointStore
} from './orcad-live-successor-completion-records'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import type * as PreparationModule from './orcad-live-successor-route-preparation'
import type * as RecordsModule from './orcad-live-successor-completion-records'
import type * as OwnershipModule from '../ipc/pty/provider/ownership-state'
import type * as RefusalModule from '../ipc/pty/provider/outgoing-source-route-refusal'

const mocked = vi.hoisted(() => ({ readiness: vi.fn() }))
vi.mock('./orcad-live-successor-readiness', () => ({
  withOrcadLiveSuccessorReadiness: (...args: unknown[]) => mocked.readiness(...args)
}))
vi.mock('../ipc/pty/provider/registry', () => ({
  sshProviders: new Map(),
  sshProvidersByGeneration: new Map()
}))
let root: string
let ownedIds: string[]
let prepareOrcadLiveSuccessorCompletion: typeof PreparationModule.prepareOrcadLiveSuccessorCompletion
let ptyOwnership: typeof OwnershipModule.ptyOwnership
let ptyIncarnationById: typeof OwnershipModule.ptyIncarnationById
let hasExactOutgoingSourcePtyRouteRefusal: typeof RefusalModule.hasExactOutgoingSourcePtyRouteRefusal
let OrcadLiveSuccessorCompletionPreparationStore: typeof RecordsModule.OrcadLiveSuccessorCompletionPreparationStore
let OrcadLiveSuccessorRouteCheckpointStore: typeof RecordsModule.OrcadLiveSuccessorRouteCheckpointStore
let bindOrcadLiveSuccessorRouteCheckpoint: typeof RecordsModule.bindOrcadLiveSuccessorRouteCheckpoint
beforeEach(async () => {
  vi.resetAllMocks()
  vi.resetModules()
  ;({ prepareOrcadLiveSuccessorCompletion } =
    await import('./orcad-live-successor-route-preparation'))
  ;({ ptyOwnership, ptyIncarnationById } = await import('../ipc/pty/provider/ownership-state'))
  ;({ hasExactOutgoingSourcePtyRouteRefusal } =
    await import('../ipc/pty/provider/outgoing-source-route-refusal'))
  ;({
    OrcadLiveSuccessorCompletionPreparationStore,
    OrcadLiveSuccessorRouteCheckpointStore,
    bindOrcadLiveSuccessorRouteCheckpoint
  } = await import('./orcad-live-successor-completion-records'))
  root = mkdtempSync(join(tmpdir(), 'orca-successor-route-preparation-'))
  ownedIds = []
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const id of ownedIds) {
    ptyOwnership.delete(id)
    ptyIncarnationById.delete(id)
  }
  rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const f = appliedCoverageFixture(root)
  const appliedEvidence = f.create()
  f.evidenceStore.persist(appliedEvidence)
  const assertCurrent = vi.fn<() => void>()
  // Native readiness is modeled; evidence stores and route-refusal state are real.
  mocked.readiness.mockImplementation(
    async (...[, operation]: Parameters<typeof withOrcadLiveSuccessorReadiness>) =>
      operation({
        record: f.record,
        appliedEvidence,
        receipts: [],
        assertCurrent,
        transitionCompletedJournal: vi.fn()
      })
  )
  const targetId = f.record.release.cutover.manifest.source.sshTargetId
  ownedIds = f.record.release.cutover.liveTerminalBindings!.map(({ identity }) =>
    toAppSshPtyId(targetId, identity.terminalId)
  )
  f.record.release.cutover.liveTerminalBindings!.forEach(({ identity }, index) => {
    expect(hasExactOutgoingSourcePtyRouteRefusal(ownedIds[index], identity, f.record.sha256)).toBe(
      false
    )
  })
  const run = () =>
    prepareOrcadLiveSuccessorCompletion({
      profileDirectory: root,
      migrationId: f.record.release.cutover.manifest.migrationId,
      signal: new AbortController().signal,
      store: {} as never,
      runtime: {} as never
    })
  return { ...f, run, assertCurrent }
}

it('persists separate successor records and restores exact full-cohort route refusal, not completion', async () => {
  const f = fixture()
  const result = await f.run()
  expect(result).toMatchObject({
    phase: 'successor-source-routes-refused',
    sourceRetirement: 'pending',
    preparation: { version: 2 },
    checkpoint: { version: 2 }
  })
  f.record.release.cutover.liveTerminalBindings!.forEach(({ identity }, index) => {
    expect(hasExactOutgoingSourcePtyRouteRefusal(ownedIds[index], identity, f.record.sha256)).toBe(
      true
    )
  })
  expect(() => bindOrcadLiveSuccessorRouteCheckpoint(root, f.record).assertCurrent()).not.toThrow()
})

it.each(['ownership', 'incarnation'] as const)(
  'refuses present %s route without removing it',
  async (kind) => {
    const f = fixture()
    const map = kind === 'ownership' ? ptyOwnership : ptyIncarnationById
    map.set(ownedIds[0], 'existing')
    await expect(f.run()).rejects.toThrow('route_present')
    expect(map.get(ownedIds[0])).toBe('existing')
    expect(new OrcadLiveSuccessorRouteCheckpointStore(root).read(f.record.identity)).toBeNull()
  }
)

it.each(['ownership', 'incarnation'] as const)(
  'refuses unexpected target %s routes outside the saved cohort',
  async (kind) => {
    const f = fixture()
    const id = toAppSshPtyId(f.record.release.cutover.manifest.source.sshTargetId, 'unexpected')
    ownedIds.push(id)
    const map = kind === 'ownership' ? ptyOwnership : ptyIncarnationById
    map.set(id, 'unexpected')
    await expect(f.run()).rejects.toThrow('route_present')
    expect(map.get(id)).toBe('unexpected')
  }
)

it('reflushes identical preparation and checkpoint on retry', async () => {
  const f = fixture()
  const preparations = vi.spyOn(OrcadLiveSuccessorCompletionPreparationStore.prototype, 'persist')
  const checkpoints = vi.spyOn(OrcadLiveSuccessorRouteCheckpointStore.prototype, 'persist')
  const first = await f.run()
  expect(await f.run()).toEqual(first)
  expect(preparations).toHaveBeenCalledTimes(2)
  expect(checkpoints).toHaveBeenCalledTimes(2)
})

it('preserves route refusal on checkpoint write failure and permits a checked retry', async () => {
  const f = fixture()
  vi.spyOn(OrcadLiveSuccessorRouteCheckpointStore.prototype, 'persist').mockImplementationOnce(
    () => {
      throw new Error('disk_failed')
    }
  )
  await expect(f.run()).rejects.toThrow('disk_failed')
  expect(new OrcadLiveSuccessorRouteCheckpointStore(root).read(f.record.identity)).toBeNull()
  expect(
    hasExactOutgoingSourcePtyRouteRefusal(ownedIds[0], f.record.identity, f.record.sha256)
  ).toBe(true)
  await expect(f.run()).resolves.toMatchObject({ sourceRetirement: 'pending' })
})

it('refuses evidence disappearing after preparation persistence', async () => {
  const f = fixture()
  const persist = OrcadLiveSuccessorCompletionPreparationStore.prototype.persist
  vi.spyOn(OrcadLiveSuccessorCompletionPreparationStore.prototype, 'persist').mockImplementation(
    function (this: PreparationStore, value) {
      const result = persist.call(this, value)
      f.remove('orcad-live-applied-coverage-evidence')
      return result
    }
  )
  await expect(f.run()).rejects.toThrow()
  expect(new OrcadLiveSuccessorRouteCheckpointStore(root).read(f.record.identity)).toBeNull()
})

it('rechecks route absence after checkpoint persistence', async () => {
  const f = fixture()
  const persist = OrcadLiveSuccessorRouteCheckpointStore.prototype.persist
  vi.spyOn(OrcadLiveSuccessorRouteCheckpointStore.prototype, 'persist').mockImplementation(
    function (this: CheckpointStore, value) {
      const result = persist.call(this, value)
      ptyOwnership.set(ownedIds[0], 'reappeared')
      return result
    }
  )
  await expect(f.run()).rejects.toThrow('route_present')
  expect(ptyOwnership.get(ownedIds[0])).toBe('reappeared')
})

it('does not persist preparation after readiness authority is lost', async () => {
  const f = fixture()
  f.assertCurrent.mockImplementation(() => {
    throw new Error('authority_lost')
  })
  await expect(f.run()).rejects.toThrow('authority_lost')
  expect(new OrcadLiveSuccessorCompletionPreparationStore(root).read(f.record.identity)).toBeNull()
})
