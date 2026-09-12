import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { RuntimeHeadlessTerminal } from './runtime-terminal-state-records'
import { isOutgoingPtyRegistrationFenced } from './outgoing-pty-registration-fence'

/** Disposal is separate from process exit; callers retain durable cleanup and route authority. */
export function prepareOutgoingPtyModelDisposal(
  runtime: object,
  ptyIds: readonly string[],
  models: Map<string, RuntimeHeadlessTerminal>,
  allowMissingModels = false
) {
  const absent: string[] = []
  const cohort = [...new Set(ptyIds)].flatMap((ptyId) => {
    const model = models.get(ptyId)
    if (!model) {
      if (!allowMissingModels || models.has(ptyId)) {
        throw new Error('orcad_outgoing_source_model_missing')
      }
      absent.push(ptyId)
      return []
    }
    return [
      {
        ptyId,
        model,
        emulator: model.emulator,
        ownership: model.ownership,
        writeChain: model.writeChain,
        sequence: model.outputSequence,
        repliesDisabled: false,
        ownershipDisposed: false,
        emulatorDisposed: false,
        removed: false
      }
    ]
  })
  const owners = new Map(cohort.map(({ model, ptyId }) => [model, ptyId]))
  const emulatorOwners = new Map(cohort.map(({ emulator, ptyId }) => [emulator, ptyId]))
  const ownershipOwners = new Map(cohort.map(({ ownership, ptyId }) => [ownership, ptyId]))
  const assertModelOwners = () => {
    if (
      owners.size !== cohort.length ||
      emulatorOwners.size !== cohort.length ||
      ownershipOwners.size !== cohort.length ||
      [...models].some(
        ([id, model]) =>
          (owners.has(model) && owners.get(model) !== id) ||
          (emulatorOwners.has(model.emulator) && emulatorOwners.get(model.emulator) !== id) ||
          (ownershipOwners.has(model.ownership) && ownershipOwners.get(model.ownership) !== id)
      )
    ) {
      throw new Error('orcad_outgoing_source_model_alias_conflict')
    }
  }
  assertModelOwners()
  const assertModels = () => {
    assertModelOwners()
    for (const ptyId of absent) {
      if (!isOutgoingPtyRegistrationFenced(runtime, ptyId)) {
        throw new Error('orcad_outgoing_source_model_disposal_unfenced')
      }
      if (models.has(ptyId)) {
        throw new Error('orcad_outgoing_source_model_changed')
      }
    }
    for (const entry of cohort) {
      if (!isOutgoingPtyRegistrationFenced(runtime, entry.ptyId)) {
        throw new Error('orcad_outgoing_source_model_disposal_unfenced')
      }
      if (
        models.get(entry.ptyId) !== (entry.removed ? undefined : entry.model) ||
        entry.model.emulator !== entry.emulator ||
        entry.model.ownership !== entry.ownership ||
        entry.model.writeChain !== entry.writeChain ||
        entry.model.outputSequence !== entry.sequence
      ) {
        throw new Error('orcad_outgoing_source_model_changed')
      }
    }
  }
  let running = false
  return {
    assertCurrent: assertModels,
    async dispose(assertAuthority: () => void, signal: AbortSignal): Promise<void> {
      if (running) {
        throw new Error('orcad_outgoing_source_model_disposal_busy')
      }
      const assertCurrent = () => {
        signal.throwIfAborted()
        assertAuthority()
        assertModels()
      }
      running = true
      try {
        assertCurrent()
        for (const entry of cohort) {
          if (!entry.ownershipDisposed) {
            await waitForPromiseWithSignal(entry.writeChain, signal)
            assertCurrent()
            await waitForPromiseWithSignal(entry.model.ownership.settle(), signal)
            assertCurrent()
          }
        }
        for (const entry of cohort) {
          assertCurrent()
          if (!entry.repliesDisabled) {
            entry.model.emulator.disableQueryReplyForwarding()
            entry.repliesDisabled = true
          }
          assertCurrent()
          if (!entry.ownershipDisposed) {
            entry.model.ownership.dispose()
            entry.ownershipDisposed = true
          }
          assertCurrent()
          if (!entry.emulatorDisposed) {
            entry.model.emulator.dispose()
            entry.emulatorDisposed = true
          }
          assertCurrent()
          if (!entry.removed) {
            models.delete(entry.ptyId)
            entry.removed = true
          }
        }
        assertCurrent()
      } finally {
        running = false
      }
    }
  }
}
