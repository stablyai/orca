import { expect, it, vi } from 'vitest'
import type { controlReleaseFixture } from '../persistence-orcad-live-retirement-installation.test'
import { readDataFile, testState } from '../persistence-test-harness'
import { cleanupOrcadLiveSourceRuntime } from './orcad-live-source-runtime-cleanup'
import { inspectOrcadLiveRetirementRecovery } from './orcad-live-retirement-recovery-inspection'
import * as secureFile from '../../shared/secure-file'
import { OrcadLiveCleanupOutputEvidenceStore } from './orcad-live-cleanup-output-evidence'
import { registerLiveRuntimeRestartTests } from './orcad-live-runtime-restart-test-cases'

export function registerLiveRuntimeCleanupTests(fixture: typeof controlReleaseFixture) {
  registerLiveRuntimeRestartTests(fixture)
  it('retains profile and all control fences when source output evidence disappears during drain', async () => {
    const f = await fixture()
    const before = readDataFile()
    f.mux.fencePtyControlsAndDrain.mockImplementationOnce(async () => f.output.uninstall())
    await expect(f.release()).rejects.toThrow('source_output_identity_unverifiable')
    expect(f.released.size).toBe(2)
    expect(readDataFile()).toEqual(before)
    expect(f.mux.dispose).not.toHaveBeenCalled()
    expect(f.output.order).not.toContain('exit')
  })

  const prepare = async () => {
    const f = await fixture()
    const remove = vi.fn(async (assertAuthority: () => void, signal: AbortSignal) => {
      signal.throwIfAborted()
      assertAuthority()
      f.assertInventory.mockImplementation(() => {
        throw new Error('original graph removed')
      })
      assertAuthority()
      return { handles: [], leafKeys: [] }
    })
    const runtime = Object.assign(f.runtime, {
      prepareOutgoingSshPtyGraphAndModelCleanup: vi.fn(() => ({ remove }))
    })
    const run = (signal = new AbortController().signal, currentRuntime = runtime) =>
      cleanupOrcadLiveSourceRuntime({
        profileDirectory: testState.dir,
        store: f.store,
        migrationId: f.cutover.manifest.migrationId,
        runtime: currentRuntime,
        remote: f.remote,
        activate: f.activate,
        signal
      })
    return { ...f, runtime, remove, run }
  }

  it('joins authenticated control release and cleanup, reacquiring authority without original graph checks', async () => {
    const f = await prepare()
    const first = new AbortController()
    expect((await f.run(first.signal)).phase).toBe('runtime-surfaces-removed')
    first.abort()
    expect((await f.run()).phase).toBe('runtime-surfaces-removed')
    expect(f.runtime.prepareOutgoingSshPtyGraphAndModelCleanup).toHaveBeenCalledOnce()
    expect(f.runtime.settleOutgoingSshPtyCatalogModels).toHaveBeenCalledOnce()
    expect(f.releaseControl).toHaveBeenCalledTimes(2)
    expect(f.remove).toHaveBeenCalledTimes(2)
    expect(
      inspectOrcadLiveRetirementRecovery(testState.dir, f.store)[0].runtimeCleanupRecorded
    ).toBe(true)
    expect(f.output.order).not.toContain('exit')
    expect(f.mux.dispose).not.toHaveBeenCalled()
  })

  it('retains prepared cleanup after partial removal fails', async () => {
    const f = await prepare()
    const remove = f.remove.getMockImplementation()!
    f.remove.mockImplementationOnce(async (...args) => {
      await remove(...args)
      throw new Error('notification failed')
    })
    await expect(f.run()).rejects.toThrow('notification failed')
    expect(
      inspectOrcadLiveRetirementRecovery(testState.dir, f.store)[0].runtimeCleanupRecorded
    ).toBeUndefined()
    await f.run()
    expect(f.runtime.prepareOutgoingSshPtyGraphAndModelCleanup).toHaveBeenCalledOnce()
    expect(f.releaseControl).toHaveBeenCalledTimes(2)
  })

  it('reflushes uncertain output evidence before any runtime cleanup', async () => {
    const f = await prepare()
    const write = secureFile.writeDurableSecureJsonFile
    let failed = false
    vi.spyOn(secureFile, 'writeDurableSecureJsonFile').mockImplementation((...args) => {
      const result = write(...args)
      if (!failed && String(args[0]).includes('orcad-live-cleanup-output-evidence')) {
        failed = true
        throw new Error('output evidence durability uncertain')
      }
      return result
    })
    await expect(f.run()).rejects.toThrow('output evidence durability uncertain')
    expect(f.remove).not.toHaveBeenCalled()
    await f.run()
    expect(f.remove).toHaveBeenCalledOnce()
    expect(
      new OrcadLiveCleanupOutputEvidenceStore(testState.dir).read(f.record.identity)?.settlements
    ).toHaveLength(2)
    expect(
      inspectOrcadLiveRetirementRecovery(testState.dir, f.store)[0].sourceOutputSettlementRecorded
    ).toBe(true)
  })

  it('refuses output-evidence loss inside runtime cleanup before recording completion', async () => {
    const f = await prepare()
    const read = OrcadLiveCleanupOutputEvidenceStore.prototype.read
    f.remove.mockImplementationOnce(async (assertAuthority) => {
      vi.spyOn(OrcadLiveCleanupOutputEvidenceStore.prototype, 'read').mockReturnValue(null)
      assertAuthority()
      return { handles: [], leafKeys: [] }
    })
    await expect(f.run()).rejects.toThrow('output_evidence_changed')
    vi.spyOn(OrcadLiveCleanupOutputEvidenceStore.prototype, 'read').mockImplementation(read)
    expect(
      inspectOrcadLiveRetirementRecovery(testState.dir, f.store)[0].runtimeCleanupRecorded
    ).toBeUndefined()
    await f.run()
  })

  it('reflushes an uncertain completion checkpoint on retry without reopening control release', async () => {
    const f = await prepare()
    const write = secureFile.writeDurableSecureJsonFile
    let failed = false
    vi.spyOn(secureFile, 'writeDurableSecureJsonFile').mockImplementation((...args) => {
      const result = write(...args)
      if (!failed && String(args[0]).includes('orcad-live-runtime-cleanup-checkpoints')) {
        failed = true
        throw new Error('completion durability uncertain')
      }
      return result
    })
    await expect(f.run()).rejects.toThrow('completion durability uncertain')
    await f.run()
    expect(f.remove).toHaveBeenCalledTimes(2)
    expect(f.runtime.settleOutgoingSshPtyCatalogModels).toHaveBeenCalledOnce()
  })

  it('refuses to reconstruct cleanup in a replacement runtime from historical completion alone', async () => {
    const f = await prepare()
    await f.run()
    await expect(f.run(undefined, { ...f.runtime })).rejects.toThrow(
      'restart_reconstruction_required'
    )
    expect(f.remove).toHaveBeenCalledOnce()
  })

  it('retries an uncertain preparation write before any runtime cleanup', async () => {
    const f = await prepare()
    const write = secureFile.writeDurableSecureJsonFile
    let failed = false
    vi.spyOn(secureFile, 'writeDurableSecureJsonFile').mockImplementation((...args) => {
      const result = write(...args)
      if (!failed && String(args[0]).includes('orcad-live-source-cleanup-intents')) {
        failed = true
        throw new Error('preparation durability uncertain')
      }
      return result
    })
    await expect(f.run()).rejects.toThrow('preparation durability uncertain')
    expect(f.remove).not.toHaveBeenCalled()
    await f.run()
    expect(f.remove).toHaveBeenCalledOnce()
  })

  it('retries failed runtime preparation without repeating completed control release', async () => {
    const f = await prepare()
    f.runtime.prepareOutgoingSshPtyGraphAndModelCleanup.mockImplementationOnce(() => {
      throw new Error('snapshot preparation failed')
    })
    await expect(f.run()).rejects.toThrow('snapshot preparation failed')
    await f.run()
    expect(f.remove).toHaveBeenCalledOnce()
    expect(f.releaseControl).toHaveBeenCalledTimes(2)
  })

  it('refuses changed provider generation on retry before further cleanup', async () => {
    const f = await prepare()
    await f.run()
    Object.defineProperty(f.provider, 'providerGeneration', { value: 2 })
    await expect(f.run()).rejects.toThrow('incumbent_changed')
    expect(f.remove).toHaveBeenCalledOnce()
  })

  it('retains the original provider binding across the pre-release profile flush', async () => {
    const f = await prepare()
    const flush = f.store.flushPendingOrThrowAsync.bind(f.store)
    vi.spyOn(f.store, 'flushPendingOrThrowAsync').mockImplementationOnce(async (options) => {
      await flush(options)
      Object.defineProperty(f.provider, 'providerGeneration', { value: 2 })
    })
    await expect(f.run()).rejects.toThrow('source_authority_changed')
    expect(f.releaseControl).not.toHaveBeenCalled()
    expect(f.remove).not.toHaveBeenCalled()
  })

  it('refuses lost source-output settlement on retry before further cleanup', async () => {
    const f = await prepare()
    await f.run()
    f.output.uninstall()
    await expect(f.run()).rejects.toThrow('source_output_identity_unverifiable')
    expect(f.remove).toHaveBeenCalledOnce()
  })

  it('refuses destination activation drift on retry before further cleanup', async () => {
    const f = await prepare()
    await f.run()
    const activate = f.activate.getMockImplementation()!
    f.activate.mockImplementation(async (...args) => ({
      ...(await activate(...args)),
      destinationClaim: { generation: 2, claimId: 'replacement' }
    }))
    await expect(f.run()).rejects.toThrow('activation_changed')
    expect(f.remove).toHaveBeenCalledOnce()
  })
}
