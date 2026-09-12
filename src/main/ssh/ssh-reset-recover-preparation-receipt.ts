import { validateRelayResetPreparationRecord } from '../../shared/relay-reset-preparation-contract'
import { parseSshRelayResetIntent, type SshRelayResetIntent } from './ssh-relay-reset-intent'
import type { SshRelayResetIntentStore } from './ssh-relay-reset-intent-store'
import {
  parseSshRelayResetPreparationReceipt,
  parseSshRelayResetRetirementSelection,
  sshRelayResetRecordDigest
} from './ssh-relay-reset-retirement-record'
import { readSshResetPreparation } from './ssh-relay-reset-read-preparation'
import type { SshResetRecoveryConnection } from './ssh-reset-recovery-destination'

/** Recovers only prepared evidence; never supplies transport-drain or local-retirement proof. */
export async function recoverSshResetPreparationReceipt(options: {
  intent: SshRelayResetIntent
  records: Pick<
    SshRelayResetIntentStore,
    'read' | 'readSelection' | 'readReceipt' | 'persist' | 'persistSelection' | 'persistReceipt'
  >
  connection: SshResetRecoveryConnection
  signal: AbortSignal
  assertAuthority: () => void
}) {
  const { records, signal, connection } = options
  const intent = parseSshRelayResetIntent(options.intent)
  const intentDigest = sshRelayResetRecordDigest(intent)
  const assertIntent = (): void => {
    signal.throwIfAborted()
    options.assertAuthority()
    signal.throwIfAborted()
    if (sshRelayResetRecordDigest(records.read(intent.targetId)) !== intentDigest) {
      throw new Error('ssh_reset_recovery_intent_changed')
    }
  }
  assertIntent()
  const selected = records.readSelection(intent)
  if (!selected) {
    throw new Error('ssh_reset_recovery_selection_missing')
  }
  const selection = parseSshRelayResetRetirementSelection(selected, intent)
  const selectionDigest = sshRelayResetRecordDigest(selection)
  const assertEvidence = (): void => {
    assertIntent()
    if (sshRelayResetRecordDigest(records.readSelection(intent)) !== selectionDigest) {
      throw new Error('ssh_reset_recovery_selection_changed')
    }
  }
  assertEvidence()
  const previous = records.readReceipt(intent)
  let receipt = previous ? parseSshRelayResetPreparationReceipt(previous, intent, selection) : null
  if (!receipt) {
    const evidence = await readSshResetPreparation({
      intent,
      connection,
      signal,
      assertDestinationCurrent: assertEvidence
    })
    assertEvidence()
    evidence.assertCurrent()
    if (!evidence.preparation) {
      throw new Error('ssh_reset_recovery_preparation_unverifiable')
    }
    const preparation = validateRelayResetPreparationRecord(
      evidence.preparation,
      intent.preparation!,
      intent.request
    )
    // The journal proves the same prepared fact, not delivery of the original channel ACK.
    receipt = parseSshRelayResetPreparationReceipt(
      {
        version: 1,
        intentSha256: intentDigest,
        selectionSha256: selectionDigest,
        acknowledgment: {
          version: 1,
          prepared: true,
          operationId: preparation.request.operationId,
          runtimeIncarnation: preparation.request.runtimeIncarnation
        }
      },
      intent,
      selection
    )
  }
  const receiptDigest = sshRelayResetRecordDigest(receipt)
  const assertWritten = (value: unknown, expectedDigest: string): void => {
    assertEvidence()
    if (sshRelayResetRecordDigest(value) !== expectedDigest) {
      throw new Error('ssh_reset_recovery_write_unconfirmed')
    }
  }
  assertEvidence()
  assertWritten(await records.persist(intent), intentDigest)
  assertWritten(await records.persistSelection(intent, selection), selectionDigest)
  assertWritten(await records.persistReceipt(intent, receipt), receiptDigest)
  if (sshRelayResetRecordDigest(records.readReceipt(intent)) !== receiptDigest) {
    throw new Error('ssh_reset_recovery_receipt_changed')
  }
  return receipt
}
