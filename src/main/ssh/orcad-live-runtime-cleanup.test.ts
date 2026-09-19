import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as secure from '../../shared/secure-file'
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
  createOrcadLiveRuntimeCleanupCheckpoint,
  listValidatedOrcadLiveRuntimeCleanupCheckpoints,
  OrcadLiveRuntimeCleanupCheckpointStore
} from './orcad-live-runtime-cleanup-checkpoint'
import { completeOrcadLiveRuntimeSurfaceCleanup } from './orcad-live-runtime-cleanup'
import { inspectOrcadLiveRetirementRecovery } from './orcad-live-retirement-recovery-inspection'
import { restoreOutgoingOrcadPreparationAdmission } from './orcad-outgoing-preparation-startup'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { fenceOutgoingPtyRegistrations } from '../runtime/outgoing-pty-registration-fence'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-runtime-cleanup-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})
function fixture(saveIntent = true) {
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
  new OrcadLiveSourceRetirementRecordStore(root).persist(record)
  if (saveIntent) {
    new OrcadLiveSourceCleanupIntentStore(root).persist(createOrcadLiveSourceCleanupIntent(record))
  }
  const cleanup = { remove: vi.fn(async () => ({ handles: [], leafKeys: [] })) }
  const options = {
    profileDirectory: root,
    record,
    cleanup,
    assertAuthority: vi.fn(),
    signal: new AbortController().signal
  }
  return { record, cleanup, options, checkpoints: new OrcadLiveRuntimeCleanupCheckpointStore(root) }
}

it('persists the historical stage only after runtime cleanup succeeds', async () => {
  const f = fixture()
  f.cleanup.remove.mockImplementationOnce(async () => {
    expect(f.checkpoints.list()).toEqual([])
    return { handles: [], leafKeys: [] }
  })
  const checkpoint = await completeOrcadLiveRuntimeSurfaceCleanup(f.options)
  expect(checkpoint.phase).toBe('runtime-surfaces-removed')
  expect(listValidatedOrcadLiveRuntimeCleanupCheckpoints(root)).toEqual([
    { checkpoint, record: f.record }
  ])
  expect(
    inspectOrcadLiveRetirementRecovery(root, {
      listOrcadLiveRetirementMarkers: () => [],
      inspectOrcadLiveRetirementProfileState: () => ({
        record: f.record,
        state: 'profile-installed'
      })
    } as never)
  ).toEqual([
    {
      record: f.record,
      state: 'profile-installed',
      cleanupPrepared: true,
      runtimeCleanupRecorded: true
    }
  ])
})

it('requires existing preparation intent before invoking cleanup', async () => {
  const f = fixture(false)
  await expect(completeOrcadLiveRuntimeSurfaceCleanup(f.options)).rejects.toThrow('intent_required')
  expect(f.cleanup.remove).not.toHaveBeenCalled()
})

it('checkpoints the actual prepared runtime cleanup without publishing process exit', async () => {
  const f = fixture()
  const runtime = new OrcaRuntimeService()
  const target = f.record.release.cutover.manifest.source.sshTargetId
  const ids: string[] = []
  for (const { identity, surfaceBinding } of f.record.release.cutover.liveTerminalBindings!) {
    const id = toAppSshPtyId(target, identity.terminalId)
    ids.push(id)
    runtime.registerPty(id, surfaceBinding.workspaceKey.replace(/^worktree:/, ''), target, {
      tabId: surfaceBinding.tabId,
      leafId: surfaceBinding.leafId,
      incarnationId: identity.incarnationId
    })
    await runtime.acceptPtyDataBounded(id, 'retained\r\n', Date.now()).completion
  }
  const cleanup = runtime.prepareOutgoingSshPtyGraphAndModelCleanup(target)
  const exit = vi.spyOn(runtime, 'onPtyExit')
  fenceOutgoingPtyRegistrations(runtime, ids)
  await completeOrcadLiveRuntimeSurfaceCleanup({ ...f.options, cleanup })
  await completeOrcadLiveRuntimeSurfaceCleanup({ ...f.options, cleanup })
  for (const id of ids) {
    await expect(runtime.serializeMainTerminalBuffer(id)).resolves.toBeNull()
  }
  expect(f.checkpoints.list()).toHaveLength(1)
  expect(exit).not.toHaveBeenCalled()
})

it('refuses an uncertain intent reflush before destructive cleanup', async () => {
  const f = fixture()
  vi.spyOn(secure, 'writeDurableSecureJsonFile').mockImplementationOnce(() => {
    throw new Error('intent uncertain')
  })
  await expect(completeOrcadLiveRuntimeSurfaceCleanup(f.options)).rejects.toThrow(
    'intent uncertain'
  )
  expect(f.cleanup.remove).not.toHaveBeenCalled()
  expect(f.checkpoints.list()).toEqual([])
})

it('does not checkpoint incomplete runtime cleanup', async () => {
  const f = fixture()
  f.cleanup.remove.mockRejectedValueOnce(new Error('runtime cleanup failed'))
  await expect(completeOrcadLiveRuntimeSurfaceCleanup(f.options)).rejects.toThrow(
    'runtime cleanup failed'
  )
  expect(f.checkpoints.list()).toEqual([])
})

it('refuses a conflicting checkpoint before intent reflush or runtime cleanup', async () => {
  const f = fixture()
  f.checkpoints.persist({
    ...createOrcadLiveRuntimeCleanupCheckpoint(f.record),
    retirementRecordSha256: 'f'.repeat(64)
  })
  const write = vi.spyOn(secure, 'writeDurableSecureJsonFile')
  await expect(completeOrcadLiveRuntimeSurfaceCleanup(f.options)).rejects.toThrow(
    'checkpoint_conflict'
  )
  expect(f.cleanup.remove).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
})

it('refuses unreadable checkpoint evidence before runtime cleanup', async () => {
  const f = fixture()
  vi.spyOn(OrcadLiveRuntimeCleanupCheckpointStore.prototype, 'read').mockImplementation(() => {
    throw new Error('checkpoint unreadable')
  })
  await expect(completeOrcadLiveRuntimeSurfaceCleanup(f.options)).rejects.toThrow(
    'checkpoint unreadable'
  )
  expect(f.cleanup.remove).not.toHaveBeenCalled()
})

it('reflushes an uncertain completion write after revalidating and retrying cleanup', async () => {
  const f = fixture()
  const original = secure.writeDurableSecureJsonFile
  let uncertain = true
  let checkpointWrites = 0
  vi.spyOn(secure, 'writeDurableSecureJsonFile').mockImplementation((...args) => {
    const result = original(...args)
    if (args[0].includes('orcad-live-runtime-cleanup-checkpoints')) {
      checkpointWrites++
      if (uncertain) {
        uncertain = false
        throw new Error('completion uncertain')
      }
    }
    return result
  })
  await expect(completeOrcadLiveRuntimeSurfaceCleanup(f.options)).rejects.toThrow(
    'completion uncertain'
  )
  expect(f.checkpoints.read(f.record.identity)).not.toBeNull()
  await completeOrcadLiveRuntimeSurfaceCleanup(f.options)
  expect(checkpointWrites).toBe(2)
  expect(f.cleanup.remove).toHaveBeenCalledTimes(2)
})

it('refuses completion discovery and provider startup without its preparation intent', async () => {
  const f = fixture(false)
  f.checkpoints.persist(createOrcadLiveRuntimeCleanupCheckpoint(f.record))
  expect(() => listValidatedOrcadLiveRuntimeCleanupCheckpoints(root)).toThrow('checkpoint_conflict')
  const mux = {
    fencePtyControlsAndDrain: vi.fn(async () => {}),
    fencePtyPreparationSurface: vi.fn(),
    fencePtyCatalogCreation: vi.fn()
  }
  await expect(restoreOutgoingOrcadPreparationAdmission('source', mux, root)).rejects.toThrow(
    'checkpoint_conflict'
  )
  expect(mux.fencePtyControlsAndDrain).not.toHaveBeenCalled()
  expect(mux.fencePtyCatalogCreation).not.toHaveBeenCalled()
})
