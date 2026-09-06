import type { OrchestrationDb } from './db'
import {
  shouldReleaseOrchestrationPointer,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import type { OrchestrationMailboxLeaf, OrchestrationMailboxOwner } from './mailbox-owner'
import {
  isStatuslessIdleProofCurrent,
  isStatuslessIdleProofProcessCurrent
} from './mailbox-statusless-idle-proof'
import type {
  OrchestrationMailboxDeliveryFlight,
  OrchestrationMailboxPointerState,
  OrchestrationStatuslessIdleProof
} from './mailbox-pointer-state'

type PointerSubmitDependencies<TWaiter extends OrchestrationMessageWaiter> = {
  mailboxOwner: OrchestrationMailboxOwner
  state: OrchestrationMailboxPointerState
  getDb: () => OrchestrationDb | null
  getLeaf: (leafKey: string) => OrchestrationMailboxLeaf | undefined
  getLeafKey: (tabId: string, leafId: string) => string
  getTerminalProcessIncarnation: (terminalHandle: string) => string | null
  getMessageWaiters: (mailboxHandle: string) => ReadonlySet<TWaiter> | undefined
  isLeafPtyProvenAbsent: (ptyId: string) => Promise<boolean>
  requestSleepingRecipientWake?: (mailboxHandle: string) => void
  writePty: (ptyId: string, data: string) => boolean | Promise<boolean>
  settle: (ptyId: string, flight: OrchestrationMailboxDeliveryFlight) => void
  redrive: (mailboxHandle: string, force?: boolean) => void
}

export function submitOrchestrationMailboxPointer<TWaiter extends OrchestrationMessageWaiter>(
  deps: PointerSubmitDependencies<TWaiter>,
  input: {
    leaf: OrchestrationMailboxLeaf
    mailboxHandle: string
    messages: readonly { id: string; type: string }[]
    newestSequence: number
    ptyId: string
    flight: OrchestrationMailboxDeliveryFlight
    statuslessIdleProof?: OrchestrationStatuslessIdleProof
  }
): void {
  let clearAndRedrive = false
  let submitted = false
  let releaseWithoutRedrive = false
  let finalizeReservation = true
  void deps
    .isLeafPtyProvenAbsent(input.ptyId)
    .then(async (absent) => {
      if (absent) {
        // The pane died between staging and submitting; the staged mail is put
        // back undelivered below, so ask for a wake or it waits for a tab open.
        clearAndRedrive = true
        deps.requestSleepingRecipientWake?.(input.mailboxHandle)
        return
      }
      if (!deps.state.isCurrentFlight(input.ptyId, input.flight)) {
        finalizeReservation = false
        return
      }
      const currentLeaf = deps.getLeaf(deps.getLeafKey(input.leaf.tabId, input.leaf.leafId))
      if (!currentLeaf || currentLeaf.ptyId !== input.ptyId || !currentLeaf.writable) {
        clearAndRedrive = true
      } else if (deps.mailboxOwner.resolve(currentLeaf) !== input.mailboxHandle) {
        clearAndRedrive = true
      } else if (
        input.statuslessIdleProof &&
        !isStatuslessIdleProofProcessCurrent(
          currentLeaf,
          input.statuslessIdleProof,
          deps.getTerminalProcessIncarnation
        )
      ) {
        clearAndRedrive = true
      } else if (canSubmitPointer(deps, currentLeaf, input.statuslessIdleProof)) {
        if (
          shouldReleaseOrchestrationPointer(
            deps.getDb(),
            input.mailboxHandle,
            input.messages,
            deps.getMessageWaiters(input.mailboxHandle)
          )
        ) {
          releaseWithoutRedrive = true
        } else {
          submitted = await deps.writePty(input.ptyId, '\r')
        }
      }
    })
    .catch(() => undefined)
    .finally(() => {
      let released = false
      if (finalizeReservation) {
        if (clearAndRedrive) {
          deps.getDb()?.markAsUndelivered(input.messages.map((message) => message.id))
        }
        released =
          submitted || clearAndRedrive || releaseWithoutRedrive
            ? deps.state.clearWatermark(input.mailboxHandle, input.newestSequence, input.ptyId)
            : deps.state.deactivateWatermark(input.mailboxHandle, input.newestSequence, input.ptyId)
      }
      deps.settle(input.ptyId, input.flight)
      if (released && !releaseWithoutRedrive) {
        deps.redrive(input.mailboxHandle, clearAndRedrive)
      }
    })
}

function canSubmitPointer<TWaiter extends OrchestrationMessageWaiter>(
  deps: PointerSubmitDependencies<TWaiter>,
  leaf: OrchestrationMailboxLeaf,
  proof: OrchestrationStatuslessIdleProof | undefined
): boolean {
  if (!proof) {
    // Once staged, working is queue-safe; idle-only strands Orca-owned text in the composer.
    return (
      leaf.lastAgentStatusObservedLive &&
      (leaf.lastAgentStatus === 'idle' || leaf.lastAgentStatus === 'working')
    )
  }
  return isStatuslessIdleProofCurrent(leaf, proof, deps.getTerminalProcessIncarnation)
}
