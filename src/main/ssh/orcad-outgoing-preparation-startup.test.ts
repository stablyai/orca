import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { restoreOutgoingOrcadPreparationAdmission } from './orcad-outgoing-preparation-startup'
import { assertOutgoingPtyRegistrationAllowed } from '../runtime/outgoing-pty-registration-fence'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { OrcadOutgoingPreparationStore } from './orcad-outgoing-preparation-store'
import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { createOrcadModelImportFixture } from '../orcad/orcad-model-import-test-fixture'
import {
  identity,
  preparation
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { PTY_OWNERSHIP_TRANSFER_CANARY_ENV } from '../../shared/pty-ownership-transfer-release-gate'
import { makePaneKey } from '../../shared/stable-pane-id'
import { OrcadLiveCutoverIntentStore } from './orcad-live-cutover-intent-store'
import { liveSourceRetirementFixture } from '../persistence/migrating-orcad-catalog/orcad-live-source-retirement-test-fixture'
import {
  createOrcadLiveSourceRetirementRecord,
  OrcadLiveSourceRetirementRecordStore
} from './orcad-live-source-retirement-record'
import {
  createOrcadLiveSourceCleanupIntent,
  OrcadLiveSourceCleanupIntentStore
} from './orcad-live-source-cleanup-intent'

let root: string
let mux: SshChannelMultiplexer
let write: ReturnType<typeof vi.fn<() => boolean>>
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oc-preparation-startup-'))
  write = vi.fn(() => true)
  mux = new SshChannelMultiplexer({ write, onData: () => {}, onClose: () => {} })
})
afterEach(() => {
  mux.dispose()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

function saveIntent() {
  const model = createOrcadModelImportFixture(root)
  return new OrcadOutgoingPreparationStore(root).persist({
    version: 1,
    kind: 'preparation',
    identity,
    sourceSshTargetId: 'source',
    sourceSshTargetGeneration: 1,
    destinationEnvironmentId: 'destination',
    source: model.store.loadDelegatedSource(identity),
    surfaceBinding: preparation.surfacePublication.surfaceBinding
  })
}

it('restores pending control refusal on a fresh mux even with the canary disabled', async () => {
  const saved = saveIntent()
  vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '0')
  await restoreOutgoingOrcadPreparationAdmission('source', mux, root)
  expect(mux.isPtyPreparationFenced(identity.terminalId)).toBe(true)
  expect(mux.isPtyPreparationFenced('unrelated')).toBe(false)
  expect(() => mux.notify('pty.data', { id: identity.terminalId, data: 'lost input' })).toThrow(
    'preparing'
  )
  await expect(mux.request('pty.shutdown', { id: identity.terminalId })).rejects.toThrow(
    'preparing'
  )
  const settled = vi.fn()
  mux.notifyWithSettlement('pty.resize', { id: identity.terminalId, cols: 80, rows: 24 }, settled)
  expect(settled).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: 'refused', reason: 'write_gate_denied' })
  )
  expect(write).not.toHaveBeenCalled()
  const paneKey = makePaneKey(saved.surfaceBinding.tabId, saved.surfaceBinding.leafId)
  await expect(mux.request('pty.spawn', { paneKey })).rejects.toThrow('surface_preparing')
  await expect(mux.request('pty.spawn', { env: { ORCA_PANE_KEY: paneKey } })).rejects.toThrow(
    'surface_preparing'
  )
  await expect(
    mux.request('pty.spawn', { paneKey: 'other', env: { ORCA_PANE_KEY: paneKey } })
  ).rejects.toThrow('surface_preparing')
  expect(write).not.toHaveBeenCalled()
  expect(new OrcadOutgoingPreparationStore(root).read(identity)).toEqual(saved)
  expect(mux.isDisposed()).toBe(false)
  mux.notify('pty.data', { id: 'unrelated', data: 'allowed' })
  expect(write).toHaveBeenCalledOnce()
  mux.notify('pty.spawn', { paneKey: makePaneKey('other-tab', saved.surfaceBinding.leafId) })
  expect(write).toHaveBeenCalledTimes(2)
})

it('does not fence a same-named terminal on another SSH target', async () => {
  saveIntent()
  await restoreOutgoingOrcadPreparationAdmission('other', mux, root)
  mux.notify('pty.data', { id: identity.terminalId, data: 'allowed' })
  expect(write).toHaveBeenCalledOnce()
})

it('refuses unreadable evidence instead of treating it as no pending migration', async () => {
  vi.spyOn(OrcadOutgoingPreparationStore.prototype, 'list').mockImplementation(() => {
    throw new Error('unreadable evidence')
  })
  await expect(restoreOutgoingOrcadPreparationAdmission('source', mux, root)).rejects.toThrow(
    'unreadable evidence'
  )
  expect(write).not.toHaveBeenCalled()
})

function saveCatalogIntent(kind: 'folder' | 'worktree' = 'folder') {
  const { cutover } = liveSourceRetirementFixture(kind)
  if (cutover.phase !== 'destination-committed') {
    throw new Error('Expected committed fixture')
  }
  const { terminalPublications: _publications, receipt: _receipt, ...initial } = cutover
  return new OrcadLiveCutoverIntentStore(root).persist({
    ...initial,
    phase: 'source-fenced'
  })
}

function saveCleanupIntent(kind: 'folder' | 'worktree' = 'folder', saveRecord = true) {
  const f = liveSourceRetirementFixture(kind)
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
  if (saveRecord) {
    new OrcadLiveSourceRetirementRecordStore(root).persist(record)
  }
  new OrcadLiveSourceCleanupIntentStore(root).persist(createOrcadLiveSourceCleanupIntent(record))
  return record
}

it.each(['folder', 'worktree'] as const)(
  'restores cleanup fences from exact retirement evidence without older preparation files (%s)',
  async (kind) => {
    const record = saveCleanupIntent(kind)
    vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '0')
    expect(new OrcadOutgoingPreparationStore(root).list()).toEqual([])
    expect(new OrcadLiveCutoverIntentStore(root).list()).toEqual([])
    const runtime = {}
    const targetId = record.release.cutover.manifest.source.sshTargetId
    await restoreOutgoingOrcadPreparationAdmission(targetId, mux, root, runtime)
    await expect(mux.request('pty.spawn', {})).rejects.toThrow('catalog_preparing')
    for (const { identity } of record.release.cutover.liveTerminalBindings!) {
      const ptyId = toAppSshPtyId(targetId, identity.terminalId)
      expect(() => assertOutgoingPtyRegistrationAllowed(runtime, ptyId)).toThrow(
        'source_registration_fenced'
      )
      expect(() => assertOutgoingPtyRegistrationAllowed({}, ptyId)).not.toThrow()
      expect(() =>
        assertOutgoingPtyRegistrationAllowed(runtime, toAppSshPtyId('other', identity.terminalId))
      ).not.toThrow()
      expect(mux.isPtyPreparationFenced(identity.terminalId)).toBe(true)
      await expect(mux.request('pty.shutdown', { id: identity.terminalId })).rejects.toThrow(
        'preparing'
      )
    }
    expect(write).not.toHaveBeenCalled()
    mux.notify('pty.ownershipTransfer.status', {})
    expect(write).toHaveBeenCalledOnce()
    expect(mux.isDisposed()).toBe(false)
  }
)

it('keeps a cleanup intent scoped to its execution target', async () => {
  saveCleanupIntent()
  await restoreOutgoingOrcadPreparationAdmission('another-host', mux, root)
  mux.notify('pty.spawn', {})
  expect(write).toHaveBeenCalledOnce()
})

it('refuses orphan cleanup evidence before provider publication', async () => {
  const record = saveCleanupIntent('folder', false)
  await expect(
    restoreOutgoingOrcadPreparationAdmission(
      record.release.cutover.manifest.source.sshTargetId,
      mux,
      root
    )
  ).rejects.toThrow('cleanup_recovery_record_conflict')
  expect(write).not.toHaveBeenCalled()
})

it('refuses cleanup identity that disagrees with its referenced retirement record', async () => {
  const record = saveCleanupIntent()
  const runtime = {}
  vi.spyOn(OrcadLiveSourceCleanupIntentStore.prototype, 'list').mockReturnValue([
    { ...createOrcadLiveSourceCleanupIntent(record), migrationId: 'wrong-migration' }
  ])
  await expect(
    restoreOutgoingOrcadPreparationAdmission(
      record.release.cutover.manifest.source.sshTargetId,
      mux,
      root,
      runtime
    )
  ).rejects.toThrow('cleanup_recovery_record_conflict')
  for (const { identity } of record.release.cutover.liveTerminalBindings!) {
    expect(() =>
      assertOutgoingPtyRegistrationAllowed(
        runtime,
        toAppSshPtyId(record.release.cutover.manifest.source.sshTargetId, identity.terminalId)
      )
    ).not.toThrow()
  }
  expect(write).not.toHaveBeenCalled()
})

it('refuses unreadable cleanup evidence instead of treating it as no cleanup', async () => {
  vi.spyOn(OrcadLiveSourceCleanupIntentStore.prototype, 'list').mockImplementation(() => {
    throw new Error('cleanup unreadable')
  })
  await expect(restoreOutgoingOrcadPreparationAdmission('source', mux, root)).rejects.toThrow(
    'cleanup unreadable'
  )
  expect(write).not.toHaveBeenCalled()
})

it.each(['folder', 'worktree'] as const)(
  'restores whole-catalog creation refusal without per-terminal records (%s)',
  async (kind) => {
    const intent = saveCatalogIntent(kind)
    vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '0')
    await restoreOutgoingOrcadPreparationAdmission(intent.manifest.source.sshTargetId, mux, root)
    for (const params of [
      {},
      {
        paneKey: makePaneKey('unrelated-tab', intent.liveTerminalBindings![0].surfaceBinding.leafId)
      },
      { env: { ORCA_PANE_KEY: 'unknown' } },
      { agentSessionCreateOperationId: 'a'.repeat(43) }
    ]) {
      await expect(mux.request('pty.spawn', params)).rejects.toThrow('catalog_preparing')
    }
    expect(() => mux.notify('pty.spawn', {})).toThrow('catalog_preparing')
    for (const { identity } of intent.liveTerminalBindings!) {
      expect(mux.isPtyPreparationFenced(identity.terminalId)).toBe(true)
      expect(() => mux.notify('pty.data', { id: identity.terminalId, data: 'stale' })).toThrow(
        'control_preparing'
      )
    }
    expect(write).not.toHaveBeenCalled()
    expect(new OrcadLiveCutoverIntentStore(root).read(intent.identity)).toEqual(intent)
    mux.notify('pty.ownershipTransfer.status', {})
    expect(write).toHaveBeenCalledOnce()
  }
)

it('does not apply a whole-catalog creation fence to another target', async () => {
  saveCatalogIntent()
  await restoreOutgoingOrcadPreparationAdmission('unrelated-target', mux, root)
  mux.notify('pty.spawn', {})
  expect(write).toHaveBeenCalledOnce()
})

it('refuses unreadable whole-catalog intent before provider publication', async () => {
  vi.spyOn(OrcadLiveCutoverIntentStore.prototype, 'list').mockImplementation(() => {
    throw new Error('catalog intent unreadable')
  })
  await expect(restoreOutgoingOrcadPreparationAdmission('source', mux, root)).rejects.toThrow(
    'catalog intent unreadable'
  )
  expect(write).not.toHaveBeenCalled()
})
