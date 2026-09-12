import { executeSshRelayResetWithRetirementRecords } from '../ssh/ssh-relay-reset-transaction'
import {
  parseSshRelayResetPreparationReceipt,
  sshRelayResetRecordDigest,
  type SshRelayResetCompletion
} from '../ssh/ssh-relay-reset-retirement-record'
import { completePreparedSshRelayReset } from './ssh-reset-completion'
import type { captureSshResetTransportRetirement } from './ssh-reset-captured-transport'
import type { SshResetOperationAuthority } from './ssh-reset-operation-authority'
import type { SshRelayResetIntentStore } from '../ssh/ssh-relay-reset-intent-store'
import {
  parseSshRelayResetArchive,
  type SshRelayResetArchive
} from '../ssh/ssh-relay-reset-archive'

type CompletionOptions = Parameters<typeof completePreparedSshRelayReset>[0]
type CapturedTransport = Pick<
  ReturnType<typeof captureSshResetTransportRetirement>,
  | 'begin'
  | 'drain'
  | 'mux'
  | 'provider'
  | 'onPreparedAcknowledgment'
  | 'teardown'
  | 'releaseForwardAdmission'
>

/** Retain this controller with its authority; prepared retries never send another reset. */
export function createSshResetOperation(options: {
  authority: SshResetOperationAuthority
  captured: CapturedTransport
  records: CompletionOptions['records'] &
    Pick<SshRelayResetIntentStore, 'readArchive' | 'readRetiredArchive' | 'retireArchived'>
  leases: CompletionOptions['leases']
  assertSelectionCurrent: () => void
  prepareParticipation?: () => Promise<() => void>
}) {
  const { authority, captured, records, leases, assertSelectionCurrent } = options
  const { intent, selection } = authority
  let inFlight: Promise<SshRelayResetCompletion> | undefined
  let retiredProof: (() => void) | undefined
  let finalized: SshRelayResetArchive | undefined
  let assertParticipation: (() => void) | undefined

  const finalize = async (expected: SshRelayResetArchive) => {
    const assertRetired = retiredProof
    if (!assertRetired) {
      throw new Error('ssh_reset_operation_retirement_proof_missing')
    }
    const archive = parseSshRelayResetArchive(
      await records.retireArchived(intent, assertRetired),
      intent
    )
    const digest = sshRelayResetRecordDigest(expected)
    if (sshRelayResetRecordDigest(archive) !== digest) {
      throw new Error('ssh_reset_operation_retired_archive_changed')
    }
    const assertDurablyRetired = () => {
      assertRetired()
      if (sshRelayResetRecordDigest(records.readRetiredArchive(intent)) !== digest) {
        throw new Error('ssh_reset_operation_retired_archive_changed')
      }
    }
    authority.release(archive, assertDurablyRetired, () =>
      captured.releaseForwardAdmission(assertDurablyRetired)
    )
    finalized = archive
    return archive.completion
  }

  const execute = async (signal: AbortSignal): Promise<SshRelayResetCompletion> => {
    signal.throwIfAborted()
    if (finalized) {
      if (
        sshRelayResetRecordDigest(records.readArchive(intent)) !==
        sshRelayResetRecordDigest(finalized)
      ) {
        throw new Error('ssh_reset_operation_final_archive_changed')
      }
      return finalized.completion
    }
    authority.assertAuthority()
    if (!assertParticipation && options.prepareParticipation) {
      assertParticipation = await options.prepareParticipation()
      authority.assertAuthority()
      signal.throwIfAborted()
    }
    assertParticipation?.()
    if (authority.preparationAcknowledgment) {
      const retired = records.readRetiredArchive(intent)
      if (retired) {
        return finalize(retired)
      }
    }
    if (!authority.preparationAcknowledgment) {
      captured.begin()
      await captured.drain(signal)
      signal.throwIfAborted()
      const assertInitialAuthority = () => {
        assertParticipation?.()
        authority.assertAuthority()
        assertSelectionCurrent()
        authority.assertAuthority()
      }
      assertInitialAuthority()
      await executeSshRelayResetWithRetirementRecords({
        intent,
        selection,
        mode: 'active-owner',
        mux: captured.mux,
        store: records,
        assertAuthority: assertInitialAuthority,
        onPreparedAcknowledgment: (acknowledgment, acknowledgedIntent) =>
          authority.onPreparedAcknowledgment(
            acknowledgment,
            acknowledgedIntent,
            captured.onPreparedAcknowledgment
          )
      })
    }

    assertParticipation?.()
    authority.assertPreparedAuthority()
    const receipt = parseSshRelayResetPreparationReceipt(
      {
        version: 1,
        intentSha256: authority.intentDigest,
        selectionSha256: authority.selectionDigest,
        acknowledgment: authority.preparationAcknowledgment
      },
      intent,
      selection
    )
    const receiptDigest = sshRelayResetRecordDigest(receipt)
    const assertWritten = (value: unknown, expected: string) => {
      assertParticipation?.()
      authority.assertPreparedAuthority()
      if (sshRelayResetRecordDigest(value) !== expected) {
        throw new Error('ssh_reset_operation_record_write_unconfirmed')
      }
    }
    // Reflush retained ACK evidence after an uncertain receipt write, without host mutation.
    assertWritten(await records.persist(intent), authority.intentDigest)
    assertWritten(await records.persistSelection(intent, selection), authority.selectionDigest)
    assertWritten(await records.persistReceipt(intent, receipt), receiptDigest)
    const assertPreparedRecords = () => {
      assertParticipation?.()
      authority.assertPreparedAuthority()
      if (
        sshRelayResetRecordDigest(records.readSelection(intent)) !== authority.selectionDigest ||
        sshRelayResetRecordDigest(records.readReceipt(intent)) !== receiptDigest
      ) {
        throw new Error('ssh_reset_operation_records_changed')
      }
    }
    assertPreparedRecords()
    const completion = await completePreparedSshRelayReset({
      intent,
      records,
      leases,
      expectedProvider: captured.provider,
      assertAuthority: assertPreparedRecords,
      teardownCaptured: async (assertLocalRetired) => {
        const retired = await captured.teardown(assertLocalRetired)
        retiredProof = () => {
          assertLocalRetired()
          retired.assertRetired()
        }
        return retired
      }
    })
    const archive = parseSshRelayResetArchive(records.readArchive(intent), intent)
    if (sshRelayResetRecordDigest(archive.completion) !== sshRelayResetRecordDigest(completion)) {
      throw new Error('ssh_reset_operation_final_archive_changed')
    }
    return finalize(archive)
  }

  return {
    run: (signal: AbortSignal): Promise<SshRelayResetCompletion> => {
      if (inFlight) {
        return inFlight
      }
      const running = Promise.resolve()
        .then(() => execute(signal))
        .finally(() => {
          if (inFlight === running) {
            inFlight = undefined
          }
        })
      inFlight = running
      return running
    }
  }
}
