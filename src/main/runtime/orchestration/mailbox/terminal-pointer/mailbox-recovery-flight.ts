import type { MailboxForeground } from '../../../terminal/wait/launched-agent-foreground'
import type { WriteSettlement } from '../../../../../shared/terminal/pty/lifecycle/pty-write-settlement'
import type {
  OrchestrationMailboxDeliveryFlight,
  OrchestrationMailboxPointerState
} from './mailbox-pointer-state'
import type { PointerSubmitDependencies, PointerSubmitInput } from './mailbox-pointer-submit'
import {
  MAILBOX_POINTER_ENTER_ATTEMPTED,
  MAILBOX_POINTER_WRITE_ATTEMPTED
} from '../../db/messages/mailbox-pointer-enter-state'

type RecoveryEvidence = {
  targetCurrent?: boolean
  proofCurrent?: boolean
  foreground?: MailboxForeground
  ready?: boolean
  composer?: string | null
  write?: WriteSettlement
}

/** A recovery flight owes its pointer and Enter until transport acceptance or explicit release. */
export function recoveryFlightDecision(
  state: OrchestrationMailboxPointerState,
  ptyId: string,
  flight: OrchestrationMailboxDeliveryFlight | undefined,
  evidence?: RecoveryEvidence
): 'ordinary' | 'revalidate' | 'retry' | 'release' | 'enter' | 'settle' | 'uncertain' {
  if (
    !flight?.processIncarnation ||
    state.foreground.screenRecovery(ptyId) !== flight.processIncarnation
  ) {
    return 'ordinary'
  }
  if (!evidence) {
    return 'revalidate'
  }
  if (evidence.targetCurrent === false) {
    return 'release'
  }
  if (evidence.write) {
    return evidence.write.outcome === 'refused'
      ? 'retry'
      : evidence.write.outcome === 'accepted'
        ? 'settle'
        : 'uncertain'
  }
  if (!evidence.proofCurrent || evidence.foreground !== 'agent' || !evidence.ready) {
    return 'retry'
  }
  if (evidence.composer === '') {
    return 'release'
  }
  return evidence.composer === flight.stagedPointerText ? 'enter' : 'retry'
}

export function submitRecoveryMailboxPointer(
  deps: PointerSubmitDependencies,
  input: PointerSubmitInput
): boolean {
  const { state, getDb } = deps
  const { ptyId, flight } = input
  if (recoveryFlightDecision(state, ptyId, flight) === 'ordinary') {
    return false
  }
  const ids = input.messages.map((message) => message.id)
  const reservation = { ptyId, processIncarnation: input.expectedTarget.processIncarnation }
  let phase = MAILBOX_POINTER_WRITE_ATTEMPTED
  let decision: ReturnType<typeof recoveryFlightDecision> = 'retry'
  let attempted = false
  void (async () => {
    const absent = await deps.isLeafPtyProvenAbsent(ptyId)
    const before = deps.resolveSubmitTarget(ptyId)
    if (absent || before?.processIncarnation !== reservation.processIncarnation) {
      decision = recoveryFlightDecision(state, ptyId, flight, { targetCurrent: false })
      return
    }
    // Avoid host inspections for an unchanged blocked screen; admission is checked again after await.
    if (!deps.isAgentSettledForDelivery?.(ptyId)) {
      return
    }
    const proof = await state.foreground.probeForeground(
      ptyId,
      reservation.processIncarnation,
      () => deps.readForeground(ptyId)
    )
    if (!state.isCurrentFlight(ptyId, flight)) {
      return
    }
    const target = deps.resolveSubmitTarget(ptyId)
    const current =
      target?.processIncarnation === reservation.processIncarnation &&
      target.terminal.handle === input.expectedTarget.terminal.handle &&
      deps.mailboxOwner.resolve(target.terminal, input.mailboxHandle) === input.mailboxHandle
    const ready =
      current &&
      proof.foreground === 'agent' &&
      target.terminal.lastAgentStatusObservedLive &&
      deps.isAgentSettledForDelivery?.(ptyId) !== false
    const applied = state.foreground.applyForeground(ptyId, proof, proof.foreground, ready)
    decision = recoveryFlightDecision(state, ptyId, flight, {
      targetCurrent: !!current,
      proofCurrent: applied,
      foreground: proof.foreground,
      ready,
      composer: ready ? deps.readComposerText?.(ptyId) : null
    })
    if (decision !== 'enter') {
      return
    }
    const db = getDb()
    if (db?.areUnreadMessages(input.mailboxHandle, ids) === false) {
      decision = 'release'
      return
    }
    if (!db?.markMailboxPointerEnterAttempted(ids, reservation)) {
      return
    }
    phase = MAILBOX_POINTER_ENTER_ATTEMPTED
    attempted = true
    const write = await deps.writePty(ptyId, '\r')
    decision = recoveryFlightDecision(state, ptyId, flight, { write })
    if (decision === 'retry') {
      // Refusal proves no Enter byte left; restore the same claim instead of duplicating the pointer.
      if (!db.markMailboxPointerWriteAttempted(ids, reservation, MAILBOX_POINTER_ENTER_ATTEMPTED)) {
        decision = 'uncertain'
      } else {
        phase = MAILBOX_POINTER_WRITE_ATTEMPTED
      }
    }
  })()
    .catch(() => {
      decision = attempted ? 'uncertain' : 'retry'
    })
    .finally(() => {
      if (!state.isCurrentFlight(ptyId, flight)) {
        return
      }
      if (decision === 'retry' || decision === 'enter') {
        state.deferFlightUntilIdle(ptyId)
        flight.submitEnter = () => submitRecoveryMailboxPointer(deps, input)
        deps.onDeliveryDecision?.(ptyId)
        return
      }
      try {
        if (decision === 'settle') {
          getDb()?.settleMailboxPointerEnter(ids, reservation, [phase])
        } else if (decision === 'release') {
          getDb()?.releaseMailboxPointerEnter(ids, reservation, [phase])
          deps.onDeliveryDecision?.(ptyId, { foreground: true })
        }
      } catch {
        // Keep ambiguous reservations durable when the database becomes unavailable.
        decision = 'uncertain'
      }
      const released =
        decision === 'settle' || decision === 'release'
          ? state.clearWatermark(input.mailboxHandle, input.newestSequence, ptyId)
          : state.deactivateWatermark(input.mailboxHandle, input.newestSequence, ptyId)
      deps.settle(ptyId, flight)
      if (released) {
        deps.redrive(input.mailboxHandle, decision === 'release')
      }
    })
    .catch(() => undefined)
  return true
}
