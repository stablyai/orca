import { parseSshRelayResetIntent, type SshRelayResetIntent } from './ssh-relay-reset-intent'
import {
  parseSshRelayResetRetirementSelection,
  parseSshRelayResetPreparationReceipt,
  parseSshRelayResetCompletion,
  sshRelayResetRecordDigest,
  type SshRelayResetRetirementSelection,
  type SshRelayResetPreparationReceipt,
  type SshRelayResetCompletion
} from './ssh-relay-reset-retirement-record'

export type SshRelayResetArchive = Readonly<{
  version: 1
  intent: SshRelayResetIntent
  selection: SshRelayResetRetirementSelection
  receipt: SshRelayResetPreparationReceipt
  completion: SshRelayResetCompletion
}>

/** Self-contained evidence remains readable after the active record set is retired. */
export function parseSshRelayResetArchive(
  value: unknown,
  expected: SshRelayResetIntent
): SshRelayResetArchive {
  const raw = value as SshRelayResetArchive | null
  if (!raw || raw.version !== 1) {
    throw new Error('ssh_relay_reset_archive_invalid')
  }
  const intent = parseSshRelayResetIntent(raw.intent)
  if (
    sshRelayResetRecordDigest(intent) !==
    sshRelayResetRecordDigest(parseSshRelayResetIntent(expected))
  ) {
    throw new Error('ssh_relay_reset_archive_intent_mismatch')
  }
  const selection = parseSshRelayResetRetirementSelection(raw.selection, intent)
  const receipt = parseSshRelayResetPreparationReceipt(raw.receipt, intent, selection)
  const completion = parseSshRelayResetCompletion(raw.completion, intent, selection, receipt)
  return Object.freeze({ version: 1, intent, selection, receipt, completion })
}
