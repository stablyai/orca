import type { SshTarget } from '../../shared/ssh-types'
import {
  parseRelayOwnerResetAcknowledgment,
  type RelayOwnerResetAcknowledgment
} from '../../shared/relay-owner-reset-contract'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { parseSshRelayResetIntent, type SshRelayResetIntent } from '../ssh/ssh-relay-reset-intent'
import {
  parseSshRelayResetRetirementSelection,
  sshRelayResetRecordDigest,
  type SshRelayResetRetirementSelection
} from '../ssh/ssh-relay-reset-retirement-record'
import { sshRelayResetTargetRoutingDigest } from '../ssh/ssh-relay-reset-session-binding'
import {
  parseSshRelayResetArchive,
  type SshRelayResetArchive
} from '../ssh/ssh-relay-reset-archive'

export type SshResetOperationAuthority = Readonly<{
  intent: SshRelayResetIntent
  selection: SshRelayResetRetirementSelection
  intentDigest: string
  selectionDigest: string
  preparationAcknowledgment: Readonly<RelayOwnerResetAcknowledgment> | undefined
  assertAuthority: () => void
  assertPreparedAuthority: () => void
  onPreparedAcknowledgment: (
    acknowledgment: Readonly<RelayOwnerResetAcknowledgment>,
    intent: SshRelayResetIntent,
    preserveDrain: (
      acknowledgment: Readonly<RelayOwnerResetAcknowledgment>,
      intent: SshRelayResetIntent
    ) => undefined
  ) => undefined
  removeCapturedSession: (assertLocalRetired: () => void) => void
  release: (
    archive: SshRelayResetArchive,
    assertRetired: () => void,
    releaseCapturedFences: () => undefined
  ) => undefined
}>

/** Slots remain retained through uncertain outcomes; absence never grants cleanup authority. */
export class SshResetOperationAuthorities<Session extends object> {
  private readonly slots = new Map<
    string,
    { token: object; authority: SshResetOperationAuthority }
  >()

  constructor(private readonly sessions: Pick<Map<string, Session>, 'get' | 'delete'>) {}

  get(targetId: string): SshResetOperationAuthority | undefined {
    return this.slots.get(targetId)?.authority
  }

  getTargetIds(): string[] {
    return [...this.slots.keys()]
  }

  retain(options: {
    intent: SshRelayResetIntent
    selection: SshRelayResetRetirementSelection
    session: Session
    mux: Pick<SshChannelMultiplexer, 'assertRelayResetAcknowledgmentDrained'>
    readTarget: () => SshTarget | undefined
    assertLiveAuthority: () => void
    /** Captured identity check must tolerate only this operation's intentional teardown. */
    assertCapturedIdentity: () => void
  }): SshResetOperationAuthority {
    const intent = parseSshRelayResetIntent(options.intent)
    const selection = parseSshRelayResetRetirementSelection(options.selection, intent)
    const intentDigest = sshRelayResetRecordDigest(intent)
    const selectionDigest = sshRelayResetRecordDigest(selection)
    const token = Object.freeze({ intentDigest, selectionDigest })
    const { session, mux, readTarget, assertLiveAuthority, assertCapturedIdentity } = options
    let prepared: Readonly<RelayOwnerResetAcknowledgment> | undefined
    let removed = false
    let capturing = false
    let releasing = false
    const assertTargetAndSession = () => {
      const target = readTarget()
      if (
        !target ||
        target.id !== intent.targetId ||
        target.generation !== intent.targetGeneration ||
        sshRelayResetTargetRoutingDigest(target) !== intent.targetRoutingDigest
      ) {
        throw new Error('ssh_reset_operation_target_changed')
      }
      if (this.sessions.get(intent.targetId) !== (removed ? undefined : session)) {
        throw new Error('ssh_reset_operation_session_changed')
      }
    }
    const assertSlot = () => {
      if (this.slots.get(intent.targetId)?.token !== token) {
        throw new Error('ssh_reset_operation_slot_changed')
      }
      assertTargetAndSession()
    }
    const assertPreparedAuthority = () => {
      assertSlot()
      if (!prepared) {
        throw new Error('ssh_reset_operation_preparation_unconfirmed')
      }
      assertCapturedIdentity()
      assertSlot()
    }
    const assertAuthority = () => {
      assertSlot()
      if (prepared) {
        assertPreparedAuthority()
      } else {
        assertLiveAuthority()
        assertSlot()
      }
    }
    if (this.slots.has(intent.targetId)) {
      throw new Error('ssh_reset_operation_already_retained')
    }
    assertLiveAuthority()
    assertTargetAndSession()
    if (this.slots.has(intent.targetId)) {
      throw new Error('ssh_reset_operation_already_retained')
    }
    const authority = Object.freeze({
      intent,
      selection,
      intentDigest,
      selectionDigest,
      get preparationAcknowledgment() {
        return prepared
      },
      assertAuthority,
      assertPreparedAuthority,
      release: (
        value: SshRelayResetArchive,
        assertRetired: () => void,
        releaseCapturedFences: () => undefined
      ): undefined => {
        assertPreparedAuthority()
        if (!removed || releasing) {
          throw new Error('ssh_reset_operation_release_not_admitted')
        }
        const archive = parseSshRelayResetArchive(value, intent)
        if (
          sshRelayResetRecordDigest(archive.selection) !== selectionDigest ||
          sshRelayResetRecordDigest(archive.receipt.acknowledgment) !==
            sshRelayResetRecordDigest(prepared)
        ) {
          throw new Error('ssh_reset_operation_release_archive_mismatch')
        }
        releasing = true
        try {
          assertRetired()
          assertPreparedAuthority()
          if (releaseCapturedFences() !== undefined) {
            throw new Error('ssh_reset_operation_release_not_synchronous')
          }
          assertRetired()
          assertPreparedAuthority()
          this.slots.delete(intent.targetId)
        } finally {
          releasing = false
        }
      },
      onPreparedAcknowledgment: (
        acknowledgment: Readonly<RelayOwnerResetAcknowledgment>,
        acknowledgedIntent: SshRelayResetIntent,
        preserveDrain: (
          acknowledgment: Readonly<RelayOwnerResetAcknowledgment>,
          intent: SshRelayResetIntent
        ) => undefined
      ): undefined => {
        assertAuthority()
        if (prepared || capturing) {
          throw new Error('ssh_reset_operation_acknowledgment_repeated')
        }
        if (
          sshRelayResetRecordDigest(parseSshRelayResetIntent(acknowledgedIntent)) !== intentDigest
        ) {
          throw new Error('ssh_reset_operation_intent_changed')
        }
        const ack = Object.freeze(
          parseRelayOwnerResetAcknowledgment(acknowledgment, intent.request)
        )
        mux.assertRelayResetAcknowledgmentDrained(intent.request)
        assertCapturedIdentity()
        capturing = true
        try {
          if (preserveDrain(ack, intent) !== undefined) {
            throw new Error('ssh_reset_operation_capture_not_synchronous')
          }
          assertLiveAuthority()
          mux.assertRelayResetAcknowledgmentDrained(intent.request)
          assertSlot()
          assertCapturedIdentity()
          prepared = ack
        } finally {
          capturing = false
        }
      },
      removeCapturedSession: (assertLocalRetired: () => void) => {
        assertPreparedAuthority()
        assertLocalRetired()
        assertPreparedAuthority()
        if (!removed) {
          if (!this.sessions.delete(intent.targetId)) {
            throw new Error('ssh_reset_operation_session_removal_unconfirmed')
          }
          removed = true
        }
        assertPreparedAuthority()
        assertLocalRetired()
      }
    })
    this.slots.set(intent.targetId, { token, authority })
    return authority
  }
}
