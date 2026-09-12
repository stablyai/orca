import { captureSshPtyModelAttempt } from './ssh-pty-model-capture-attempt'
import type {
  OrcadOutgoingCapture,
  OrcadOutgoingCaptureStore
} from './orcad-outgoing-capture-store'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { parseOrcadOutgoingSourceBinding } from './orcad-outgoing-capture-store'

/** Caller holds the source target lifecycle; existing candidates require recovery, never recapture. */
export async function captureOutgoingOrcadModel(options: {
  store: OrcadOutgoingCaptureStore
  destination: Omit<OrcadOutgoingCapture, 'version' | 'identity' | 'model' | 'selection'>
  capture: Omit<
    Parameters<typeof captureSshPtyModelAttempt>[0],
    'selectBaseline' | 'persistBeforeSelection'
  >
}) {
  const identity = Object.freeze({ ...options.capture.identity })
  const destination = parseOrcadOutgoingSourceBinding({
    ...structuredClone(options.destination),
    version: options.destination.catalogAdmission === undefined ? 1 : 2,
    identity
  })
  options.capture.signal.throwIfAborted()
  if (options.store.read(identity)) {
    throw new Error('orcad_outgoing_capture_recovery_required')
  }
  let persisted: OrcadOutgoingCapture | undefined
  const captured = await captureSshPtyModelAttempt({
    ...options.capture,
    identity,
    selectBaseline: true,
    persistBeforeSelection: async ({ model, selection }) => {
      persisted = options.store.persist({
        ...destination,
        version: destination.catalogAdmission === undefined ? 1 : 2,
        identity,
        model,
        selection
      })
    }
  })
  const saved = options.store.read(identity)
  if (
    !persisted ||
    !saved ||
    !captured.selection ||
    serializeOrcadMigrationValue(saved) !== serializeOrcadMigrationValue(persisted) ||
    serializeOrcadMigrationValue(saved.selection) !==
      serializeOrcadMigrationValue(captured.selection)
  ) {
    throw new Error('orcad_outgoing_capture_selection_unverifiable')
  }
  return saved
}
