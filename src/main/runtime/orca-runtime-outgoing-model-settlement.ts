import type { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeHeadlessTerminal } from './runtime-terminal-state-records'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'

export async function settleOutgoingSshPtyModels(
  runtime: Pick<OrcaRuntimeService, 'bindOutgoingSshPtyCatalogSurfaces' | 'getPtyOutputSequence'>,
  targetId: string,
  signal: AbortSignal,
  getModel: (ptyId: string) => RuntimeHeadlessTerminal | undefined
) {
  const inventory = runtime.bindOutgoingSshPtyCatalogSurfaces(targetId)
  const models = inventory.surfaces.map(({ ptyId }) => {
    const model = getModel(ptyId)
    return {
      ptyId,
      model,
      writeChain: model?.writeChain,
      sequence: runtime.getPtyOutputSequence(ptyId)
    }
  })
  const assertCurrent = () => {
    signal.throwIfAborted()
    inventory.assertCurrent()
    for (const { ptyId, model, writeChain, sequence } of models) {
      if (
        !model ||
        getModel(ptyId) !== model ||
        model.writeChain !== writeChain ||
        runtime.getPtyOutputSequence(ptyId) !== sequence
      ) {
        throw new Error('orcad_live_source_model_changed')
      }
    }
  }
  assertCurrent()
  for (const { model, writeChain } of models) {
    await waitForPromiseWithSignal(writeChain!, signal)
    assertCurrent()
    await waitForPromiseWithSignal(model!.ownership.settle(), signal)
    assertCurrent()
  }
  return { assertCurrent }
}
