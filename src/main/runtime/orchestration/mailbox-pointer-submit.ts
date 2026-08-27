import type { OrchestrationDb } from './db'
import {
  shouldReleaseOrchestrationPointer,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import type { OrchestrationMailboxLeaf, OrchestrationMailboxOwner } from './mailbox-owner'
import type {
  OrchestrationMailboxDeliveryFlight,
  OrchestrationMailboxPointerState
} from './mailbox-pointer-state'

type PointerSubmitDependencies<TWaiter extends OrchestrationMessageWaiter> = {
  mailboxOwner: OrchestrationMailboxOwner
  state: OrchestrationMailboxPointerState
  getDb: () => OrchestrationDb | null
  getLeaf: (leafKey: string) => OrchestrationMailboxLeaf | undefined
  getLeafKey: (tabId: string, leafId: string) => string
  getMessageWaiters: (mailboxHandle: string) => ReadonlySet<TWaiter> | undefined
  isLeafPtyProvenAbsent: (ptyId: string) => Promise<boolean>
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
        clearAndRedrive = true
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
        currentLeaf.lastAgentStatus === 'idle' &&
        currentLeaf.lastAgentStatusObservedLive
      ) {
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
