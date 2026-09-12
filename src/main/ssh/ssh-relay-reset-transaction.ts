import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { readRelayResetPreparationBinding } from '../../shared/relay-reset-preparation-contract'
import type { SshRelayResetIntentStore } from './ssh-relay-reset-intent-store'
import {
  parseSshRelayResetRetirementSelection,
  parseSshRelayResetPreparationReceipt,
  sshRelayResetRecordDigest,
  type SshRelayResetRetirementSelection
} from './ssh-relay-reset-retirement-record'
import { parseSshRelayResetIntent, type SshRelayResetIntent } from './ssh-relay-reset-intent'
import {
  RELAY_OWNER_RESET_METHOD,
  RELAY_PREPARED_RESET_RECOVERY_METHOD,
  parseRelayOwnerResetAcknowledgment,
  readRelayOwnerResetIncarnation,
  type RelayOwnerResetAcknowledgment
} from '../../shared/relay-owner-reset-contract'

/** Caller retains the intent through acknowledgment and durable local retirement. */
export async function executeSshRelayResetTransaction(options: {
  intent: SshRelayResetIntent
  mode: 'active-owner' | 'prepared-recovery'
  mux: Pick<SshChannelMultiplexer, 'request'> &
    Partial<Pick<SshChannelMultiplexer, 'assertRelayResetAcknowledgmentDrained'>>
  persist: (intent: SshRelayResetIntent) => Promise<SshRelayResetIntent>
  /** Recheck target, endpoint, transport and (for initial reset) current active owner. */
  assertAuthority: () => void
  /** Runs synchronously on the validated reply, before a following transport-close event. */
  onPreparedAcknowledgment?: (
    acknowledgment: Readonly<RelayOwnerResetAcknowledgment>,
    intent: SshRelayResetIntent
  ) => undefined
}): Promise<RelayOwnerResetAcknowledgment> {
  const intent = parseSshRelayResetIntent(options.intent)
  const { mux, mode, persist, assertAuthority, onPreparedAcknowledgment } = options
  let acknowledgmentCaptured = false
  assertAuthority()
  const status = await mux.request('relay.status')
  assertAuthority()
  if (readRelayOwnerResetIncarnation(status) !== intent.request.runtimeIncarnation) {
    throw new Error('relay_reset_incarnation_mismatch')
  }
  if (
    intent.preparation &&
    JSON.stringify(readRelayResetPreparationBinding(status)) !== JSON.stringify(intent.preparation)
  ) {
    throw new Error('ssh_relay_reset_preparation_binding_changed')
  }
  const saved = parseSshRelayResetIntent(await persist(intent))
  if (JSON.stringify(saved) !== JSON.stringify(intent)) {
    throw new Error('ssh_relay_reset_intent_write_unconfirmed')
  }
  assertAuthority()
  const method =
    mode === 'active-owner' ? RELAY_OWNER_RESET_METHOD : RELAY_PREPARED_RESET_RECOVERY_METHOD
  const result = await mux.request(
    method,
    { ...intent.request },
    {
      beforeResolve: (value) => {
        const acknowledgment = Object.freeze(
          parseRelayOwnerResetAcknowledgment(value, intent.request)
        )
        if (onPreparedAcknowledgment) {
          if (acknowledgmentCaptured) {
            throw new Error('ssh_relay_reset_acknowledgment_repeated')
          }
          assertAuthority()
          if (!mux.assertRelayResetAcknowledgmentDrained) {
            throw new Error('ssh_relay_reset_acknowledgment_drain_gate_missing')
          }
          mux.assertRelayResetAcknowledgmentDrained(intent.request)
          if (onPreparedAcknowledgment(acknowledgment, intent) !== undefined) {
            throw new Error('ssh_relay_reset_acknowledgment_capture_not_synchronous')
          }
          acknowledgmentCaptured = true
        }
      }
    }
  )
  if (onPreparedAcknowledgment && !acknowledgmentCaptured) {
    throw new Error('ssh_relay_reset_acknowledgment_capture_missing')
  }
  // A valid reply may arrive immediately before the daemon closes its transport.
  return parseRelayOwnerResetAcknowledgment(result, intent.request)
}

export async function executeSshRelayResetWithRetirementRecords(
  options: Omit<Parameters<typeof executeSshRelayResetTransaction>[0], 'persist'> & {
    selection: SshRelayResetRetirementSelection
    store: Pick<SshRelayResetIntentStore, 'persist' | 'persistSelection' | 'persistReceipt'>
  }
) {
  const intent = parseSshRelayResetIntent(options.intent)
  const selection = parseSshRelayResetRetirementSelection(options.selection, intent)
  const { store } = options
  const acknowledgment = await executeSshRelayResetTransaction({
    ...options,
    intent,
    persist: async (value) => {
      const saved = await store.persist(value)
      const selected = await store.persistSelection(value, selection)
      if (JSON.stringify(selected) !== JSON.stringify(selection)) {
        throw new Error('ssh_relay_reset_selection_write_unconfirmed')
      }
      return saved
    }
  })
  const receipt = await store.persistReceipt(intent, {
    version: 1,
    intentSha256: selection.intentSha256,
    selectionSha256: sshRelayResetRecordDigest(selection),
    acknowledgment
  })
  return parseSshRelayResetPreparationReceipt(receipt, intent, selection)
}
