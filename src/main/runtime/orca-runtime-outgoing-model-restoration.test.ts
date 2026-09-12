import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { fenceOutgoingPtyRegistrations } from './outgoing-pty-registration-fence'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'

const ptyId = toAppSshPtyId('source', 'pty')
const snapshot = { modelData: 'old snapshot', cols: 80, rows: 24, sequence: 10 }
class Runtime extends OrcaRuntimeService {
  model() {
    return this.headlessTerminals.get(ptyId)
  }
  createModel() {
    return this.createPtyHeadlessTerminalState(ptyId, snapshot)
  }
  hydrateModel() {
    return this.maybeHydrateHeadlessFromRenderer(ptyId)
  }
  replaceModel() {
    return this.replaceHeadlessTerminalAfterExecutionContextChange(ptyId)
  }
  trackModel() {
    return this.trackHeadlessTerminalData(ptyId, 'stale', 10)
  }
  snapshotPreferred() {
    return this.providerSnapshotPreferredPtys.has(ptyId)
  }
  hydrateState() {
    return this.headlessHydrationState.get(ptyId)
  }
}

it.each([false, true])(
  'refuses source snapshot mutation with existing model=%s',
  async (existing) => {
    const runtime = new Runtime()
    runtime.registerPty(ptyId, 'folder:source', 'source')
    if (existing) {
      await runtime.acceptPtyDataBounded(ptyId, 'retained\r\n', Date.now()).completion
    }
    const model = runtime.model()
    const chain = model?.writeChain
    const sequence = runtime.getPtyOutputSequence(ptyId)
    const hydration = runtime.hydrateState()
    const dispose = model ? vi.spyOn(model.emulator, 'dispose') : null
    const exit = vi.spyOn(runtime, 'onPtyExit')
    fenceOutgoingPtyRegistrations(runtime, [ptyId])
    for (const mutate of [
      () =>
        runtime.seedHeadlessTerminal(ptyId, 'stale', snapshot, { preferProviderIfExisting: true }),
      () => runtime.restoreHeadlessTerminalModel(ptyId, snapshot, () => true),
      () => runtime.seedTerminalRestoreTail(ptyId, { text: 'stale', lastTitle: 'wrong' }),
      () => runtime.createModel(),
      () => runtime.hydrateModel(),
      () => runtime.replaceModel(),
      () => runtime.trackModel(),
      () => runtime.reflowHeadlessTerminalToPtyGrid(ptyId, 120, 40),
      () =>
        runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery(ptyId, {
          data: 'stale',
          cols: 80,
          rows: 24
        })
    ]) {
      expect(mutate).toThrow('source_model_mutation_fenced')
    }
    await expect(runtime.clearHeadlessTerminalBuffer(ptyId)).rejects.toThrow(
      'source_model_mutation_fenced'
    )
    expect(runtime.model()).toBe(model)
    expect(runtime.model()?.writeChain).toBe(chain)
    expect(runtime.getPtyOutputSequence(ptyId)).toBe(sequence)
    expect(runtime.snapshotPreferred()).toBe(false)
    expect(runtime.hydrateState()).toBe(hydration)
    expect(exit).not.toHaveBeenCalled()
    if (dispose) {
      expect(dispose).not.toHaveBeenCalled()
    }
  }
)

it('allows snapshot restoration on another host and runtime', async () => {
  const runtime = new Runtime()
  fenceOutgoingPtyRegistrations(runtime, [ptyId])
  await expect(
    runtime.restoreHeadlessTerminalModel(toAppSshPtyId('other', 'pty'), snapshot, () => true)
  ).resolves.toBeUndefined()
  const other = new Runtime()
  await expect(
    other.restoreHeadlessTerminalModel(ptyId, snapshot, () => true)
  ).resolves.toBeUndefined()
})

it('refuses buffer clearing before calling the execution provider', async () => {
  const runtime = new Runtime()
  const clearBuffer = vi.fn(async () => {})
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    clearBuffer
  })
  vi.spyOn(runtime, 'resolveLeafForHandle').mockReturnValue({ ptyId })
  fenceOutgoingPtyRegistrations(runtime, [ptyId])
  await expect(runtime.clearTerminalBuffer('term-source')).rejects.toThrow(
    'source_model_mutation_fenced'
  )
  expect(clearBuffer).not.toHaveBeenCalled()
})
