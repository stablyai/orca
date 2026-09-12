import type { Store } from '../persistence'
import type { IPtyProvider } from '../providers/types'
import { parseSshRelayResetIntent, type SshRelayResetIntent } from '../ssh/ssh-relay-reset-intent'
import type { SshRelayResetIntentStore } from '../ssh/ssh-relay-reset-intent-store'
import { parseSshRelayResetArchive } from '../ssh/ssh-relay-reset-archive'
import {
  parseSshRelayResetCompletion,
  sshRelayResetRecordDigest,
  type SshRelayResetCompletion
} from '../ssh/ssh-relay-reset-retirement-record'
import {
  assertSshResetRoutesRetirable,
  retireSshResetRoutes
} from './pty/provider/ssh-reset-route-retirement'

/** Reconciles retained host preparation; never sends reset, deploys, or infers process exit. */
export async function completePreparedSshRelayReset(options: {
  intent: SshRelayResetIntent
  records: Pick<
    SshRelayResetIntentStore,
    | 'readSelection'
    | 'readReceipt'
    | 'readCompletion'
    | 'persist'
    | 'persistSelection'
    | 'persistReceipt'
    | 'persistCompletion'
    | 'archiveCompleted'
  >
  leases: Pick<Store, 'retireSshRemotePtyLeaseSelection'>
  expectedProvider?: IPtyProvider
  /** Stable operation/target authority, valid after captured transport/provider removal. */
  assertAuthority: () => void
  /** Exact captured resources only; ordinary target-wide detach/dispose is not safe here. */
  teardownCaptured: (assertLocalRetired: () => void) => Promise<{ assertRetired: () => void }>
}): Promise<SshRelayResetCompletion> {
  const intent = parseSshRelayResetIntent(options.intent)
  const { records, leases, assertAuthority, teardownCaptured, expectedProvider } = options
  assertAuthority()
  const selection = records.readSelection(intent)
  const receipt = records.readReceipt(intent)
  if (!selection || !receipt) {
    throw new Error('ssh_relay_reset_preparation_missing')
  }
  // Even a retained completion must be revalidated and reflushed after an uncertain return.
  records.readCompletion(intent)
  const selectionDigest = sshRelayResetRecordDigest(selection)
  const receiptDigest = sshRelayResetRecordDigest(receipt)
  const assertEvidence = () => {
    assertAuthority()
    if (
      sshRelayResetRecordDigest(records.readSelection(intent)) !== selectionDigest ||
      sshRelayResetRecordDigest(records.readReceipt(intent)) !== receiptDigest
    ) {
      throw new Error('ssh_relay_reset_preparation_changed')
    }
  }
  const assertWritten = (value: unknown, expectedDigest: string) => {
    assertEvidence()
    if (sshRelayResetRecordDigest(value) !== expectedDigest) {
      throw new Error('ssh_relay_reset_preparation_write_unconfirmed')
    }
  }
  assertEvidence()
  assertWritten(await records.persist(intent), sshRelayResetRecordDigest(intent))
  assertWritten(await records.persistSelection(intent, selection), selectionDigest)
  assertWritten(await records.persistReceipt(intent, receipt), receiptDigest)

  assertSshResetRoutesRetirable({
    intent,
    selection,
    receipt,
    expectedProvider,
    assertAuthority: assertEvidence
  })
  const leaseRetirement = await leases.retireSshRemotePtyLeaseSelection(
    intent.targetId,
    selection.leases,
    selection.retiredAt
  )
  const assertLeases = () => {
    assertEvidence()
    leaseRetirement.assertRetired()
  }
  assertLeases()
  const routeRetirement = retireSshResetRoutes({
    intent,
    selection,
    receipt,
    expectedProvider,
    assertAuthority: assertLeases
  })
  routeRetirement.assertRetired()
  const capturedRetirement = await teardownCaptured(routeRetirement.assertRetired)
  const assertRetired = () => {
    routeRetirement.assertRetired()
    capturedRetirement.assertRetired()
  }
  assertRetired()
  const completion = parseSshRelayResetCompletion(
    {
      version: 1,
      intentSha256: receipt.intentSha256,
      selectionSha256: receipt.selectionSha256,
      receiptSha256: receiptDigest,
      localRetired: true
    },
    intent,
    selection,
    receipt
  )
  const saved = await records.persistCompletion(intent, completion, assertRetired)
  assertRetired()
  const confirmed = parseSshRelayResetCompletion(saved, intent, selection, receipt)
  const archived = parseSshRelayResetArchive(
    await records.archiveCompleted(intent, assertRetired),
    intent
  )
  assertRetired()
  if (sshRelayResetRecordDigest(archived.completion) !== sshRelayResetRecordDigest(confirmed)) {
    throw new Error('ssh_relay_reset_archive_completion_changed')
  }
  return confirmed
}
