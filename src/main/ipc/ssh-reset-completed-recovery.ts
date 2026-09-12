import { completePreparedSshRelayReset } from './ssh-reset-completion'
import { SSH_RESET_CLIENT_INCARNATION } from './pty/provider/ssh-reset-route-retirement'
import { parseSshRelayResetIntent, type SshRelayResetIntent } from '../ssh/ssh-relay-reset-intent'
import {
  parseSshRelayResetArchive,
  type SshRelayResetArchive
} from '../ssh/ssh-relay-reset-archive'
import type { SshRelayResetIntentStore } from '../ssh/ssh-relay-reset-intent-store'
import { sshRelayResetRecordDigest } from '../ssh/ssh-relay-reset-retirement-record'
import { retainSshResetSuccessorProfileAuthority } from './ssh-reset-successor-profile-authority'

type ProfileAuthority =
  | { profileRoot: string; assertExclusiveProfile?: never }
  | { profileRoot?: never; assertExclusiveProfile: () => void }

/** Retain until release succeeds; historical completion is not proof of current resource absence. */
export function createCompletedSshResetRecovery(
  options: {
    intent: SshRelayResetIntent
    records: SshRelayResetIntentStore
    leases: Parameters<typeof completePreparedSshRelayReset>[0]['leases']
    assertAuthority: () => void
    assertResourcesAbsent: () => void
    releaseReservation: (assertRetired: () => void) => void
  } & ProfileAuthority
) {
  const intent = parseSshRelayResetIntent(options.intent)
  const { records } = options
  let historical: SshRelayResetArchive | undefined
  let retiredProof: (() => void) | undefined
  let finalized: SshRelayResetArchive | undefined
  let activeSignal: AbortSignal | undefined
  let inFlight: Promise<SshRelayResetArchive> | undefined
  let assertExclusiveProfile =
    options.profileRoot === undefined ? options.assertExclusiveProfile : undefined
  const assertCurrent = () => {
    activeSignal?.throwIfAborted()
    options.assertAuthority()
    if (!assertExclusiveProfile) {
      const selection = records.readSelection(intent)
      if (!selection || options.profileRoot === undefined) {
        throw new Error('ssh_reset_recovery_profile_authority_unavailable')
      }
      assertExclusiveProfile = retainSshResetSuccessorProfileAuthority(
        options.profileRoot,
        intent,
        selection
      )
    }
    assertExclusiveProfile()
    options.assertResourcesAbsent()
    activeSignal?.throwIfAborted()
  }
  const readCompleted = () =>
    parseSshRelayResetArchive(
      {
        version: 1,
        intent,
        selection: records.readSelection(intent),
        receipt: records.readReceipt(intent),
        completion: records.readCompletion(intent)
      },
      intent
    )
  const assertHistorical = () => {
    assertCurrent()
    if (
      !historical ||
      sshRelayResetRecordDigest(readCompleted()) !== sshRelayResetRecordDigest(historical)
    ) {
      throw new Error('ssh_reset_recovery_completion_changed')
    }
  }
  const execute = async () => {
    activeSignal?.throwIfAborted()
    if (finalized) {
      if (
        sshRelayResetRecordDigest(records.readArchive(intent)) !==
        sshRelayResetRecordDigest(finalized)
      ) {
        throw new Error('ssh_reset_recovery_archive_changed')
      }
      return finalized
    }
    assertCurrent()
    historical ??= readCompleted()
    if (historical.selection.clientIncarnation === SSH_RESET_CLIENT_INCARNATION) {
      throw new Error('ssh_reset_recovery_same_client_requires_controller')
    }
    assertHistorical()
    if (!records.readRetiredArchive(intent)) {
      await completePreparedSshRelayReset({
        intent,
        records,
        leases: options.leases,
        assertAuthority: assertHistorical,
        teardownCaptured: async (assertLocalRetired) => {
          const assertRetired = () => {
            assertLocalRetired()
            assertHistorical()
          }
          assertRetired()
          retiredProof = assertRetired
          return { assertRetired }
        }
      })
    }
    // A disk marker alone cannot restore this process's route/lease proof.
    if (!retiredProof) {
      throw new Error('ssh_reset_recovery_retirement_proof_missing')
    }
    const assertRetired = retiredProof
    assertRetired()
    const archived = parseSshRelayResetArchive(
      await records.retireArchived(intent, assertRetired),
      intent
    )
    assertRetired()
    if (sshRelayResetRecordDigest(archived) !== sshRelayResetRecordDigest(historical)) {
      throw new Error('ssh_reset_recovery_archive_changed')
    }
    const assertDurablyRetired = () => {
      assertRetired()
      if (
        sshRelayResetRecordDigest(records.readRetiredArchive(intent)) !==
        sshRelayResetRecordDigest(archived)
      ) {
        throw new Error('ssh_reset_recovery_retired_archive_changed')
      }
    }
    assertDurablyRetired()
    options.releaseReservation(assertDurablyRetired)
    finalized = archived
    return archived
  }
  return {
    run: (signal: AbortSignal): Promise<SshRelayResetArchive> => {
      if (inFlight) {
        return inFlight
      }
      activeSignal = signal
      const running = Promise.resolve()
        .then(execute)
        .finally(() => {
          if (inFlight === running) {
            inFlight = undefined
            activeSignal = undefined
          }
        })
      inFlight = running
      return running
    }
  }
}
