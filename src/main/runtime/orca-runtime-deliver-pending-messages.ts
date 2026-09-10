// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithResolveExitWaiters } from './orca-runtime-resolve-exit-waiters'
import type { RuntimeLeafRecord } from './runtime-terminal-state-records'
import { formatMessagePointer } from './orchestration/formatter'
import { isCursorAgentOrchestrationTarget } from './orca-runtime-core'

export class OrcaRuntimeWithDeliverPendingMessages extends OrcaRuntimeWithResolveExitWaiters {
  // Why: normal delivery stays event-driven; the bounded mailbox retry only repairs missed liveness edges.
  protected deliverPendingMessages(
    leaf: RuntimeLeafRecord,
    options: {
      mailboxHandle?: string
      reservedTypes?: ReadonlySet<string>
      skipAbsenceProbe?: boolean
    } = {}
  ): void {
    if (!this._orchestrationDb) {
      return
    }

    const handle = this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId))
    if (!handle) {
      return
    }
    const mailboxHandle = options.mailboxHandle ?? handle

    if (leaf.ptyId && this.messageDeliveryFlightsByPtyId.has(leaf.ptyId)) {
      let parked = this.parkedMessageRedeliveriesByPtyId.get(leaf.ptyId)
      if (!parked) {
        parked = new Map()
        this.parkedMessageRedeliveriesByPtyId.set(leaf.ptyId, parked)
      }
      const priorReservedTypes = parked.get(mailboxHandle)?.reservedTypes
      const reservedTypes =
        priorReservedTypes || options.reservedTypes
          ? new Set([...(priorReservedTypes ?? []), ...(options.reservedTypes ?? [])])
          : undefined
      parked.set(mailboxHandle, { leaf, reservedTypes })
      return
    }

    // Why filter here and not at the trigger: the push reads every pending row,
    // not just the one that woke it, so a row a pull has claimed would be typed
    // into the pane AND returned by that pull's check. Live waiters cover the
    // still-blocked case; reservedTypes carries the notify-time snapshot for a
    // waiter resolved later in the same drain, which is already gone from the map.
    const unread = this._orchestrationDb
      .getUndeliveredUnreadMessages(mailboxHandle)
      .filter(
        (message) =>
          !options.reservedTypes?.has(message.type) &&
          !this.messageWaiters.typeHasLiveWaiter(mailboxHandle, message.type)
      )
    if (unread.length === 0) {
      return
    }

    const watermark = this.lastPointedMessageSequenceByHandle.get(mailboxHandle) ?? -1
    const priorPointedIds = this.pointedMessageIdsByHandle.get(mailboxHandle)
    if (
      !unread.some(
        (message) => message.sequence > watermark || priorPointedIds?.has(message.id) !== true
      )
    ) {
      return
    }

    if (!leaf.writable || !leaf.ptyId) {
      return
    }
    const newestSequence = unread.at(-1)?.sequence
    if (newestSequence === undefined) {
      return
    }

    if (
      !options.skipAbsenceProbe &&
      this.ptyController?.probePtyLiveness &&
      !this.controllerKnowsPtyIsLive(leaf.ptyId)
    ) {
      // Why: a fire-and-forget write to a prior process's ptyId reports success
      // and would mark these delivered while losing them. Proven absence keeps
      // them queued for a future surface; unknown liveness still delivers.
      const probedPtyId = leaf.ptyId
      // Why: triggers arriving mid-probe must not each arm a continuation — the
      // Every continuation would re-read the same unread rows. The single armed
      // continuation re-reads fresh rows when it fires, so nothing is lost.
      if (this.probeDeferredDeliveryPtyIds.has(probedPtyId)) {
        return
      }
      this.probeDeferredDeliveryPtyIds.add(probedPtyId)
      void this.isLeafPtyProvenAbsent(probedPtyId)
        .then((absent) => {
          this.probeDeferredDeliveryPtyIds.delete(probedPtyId)
          if (!absent && leaf.ptyId === probedPtyId) {
            // Why a macrotask and not the stale reservation snapshot: a `remote:`
            // pty answers the probe null before its first await, so this chain can
            // settle in microtasks and overtake the resumption of a check resolved
            // meanwhile — that check's waiter is already out of the map and its
            // rows are not yet read, so the push would inject what it returns.
            // Yielding the turn lets every queued check mark its rows read first;
            // re-reading then (rather than replaying a reservation this probe may
            // have outlived) is what keeps an orphaned row from stranding.
            setTimeout(() => {
              // Why current state, not the closure: the gate that authorized this
              // push ran before the probe. A same-id cold restore inside the probe
              // window keeps ptyId identical and makes the leaf writable again, so
              // an id-only check would type the pointer plus Enter into a process
              // whose idle was never observed. Re-read the live-idle gate.
              const currentLeaf = this.leaves.get(this.getLeafKey(leaf.tabId, leaf.leafId))
              if (
                currentLeaf?.ptyId === probedPtyId &&
                currentLeaf.lastAgentStatus === 'idle' &&
                currentLeaf.lastAgentStatusObservedLive
              ) {
                this.deliverPendingMessages(currentLeaf, {
                  mailboxHandle,
                  skipAbsenceProbe: true
                })
              }
            }, 0)
          }
        })
        .catch(() => {
          this.probeDeferredDeliveryPtyIds.delete(probedPtyId)
        })
      return
    }

    const deliveryPtyId = leaf.ptyId
    const flight: { enterTimer: ReturnType<typeof setTimeout> | null } = { enterTimer: null }
    this.messageDeliveryFlightsByPtyId.set(deliveryPtyId, flight)
    // Why: every sync outcome — failed write, Cursor branch, or a throw —
    // must end the flight here, or a leaked flag parks this pty's deliveries
    // forever. Only an armed Enter hands settling to its own callback.
    let settlesInEnterCallback = false
    try {
      const payload = formatMessagePointer(unread.length, mailboxHandle)
      const wrote = this.ptyController?.write(deliveryPtyId, payload) ?? false
      if (!wrote) {
        return
      }
      this.lastPointedMessageSequenceByHandle.set(
        mailboxHandle,
        Math.max(watermark, newestSequence)
      )
      const pointedIdsAfterWrite =
        this.pointedMessageIdsByHandle.get(mailboxHandle) ?? new Set<string>()
      for (const message of unread) {
        pointedIdsAfterWrite.add(message.id)
      }
      this.pointedMessageIdsByHandle.set(mailboxHandle, pointedIdsAfterWrite)

      const tabTitle = this.tabs.get(leaf.tabId)?.title
      if (isCursorAgentOrchestrationTarget(leaf, tabTitle)) {
        // Why: Cursor Agent treats injected PTY text as editable prompt input, so submitting must stay under user control.
        return
      }

      // Why: agent TUIs can swallow a \r in the same PTY write; submit separately after a delay.
      flight.enterTimer = setTimeout(() => {
        try {
          // Why current state, not the closure: graph resync replaces leaf
          // objects, so the captured record can read writable=true after the
          // pty died, and an exit retire may have superseded this flight.
          if (this.messageDeliveryFlightsByPtyId.get(deliveryPtyId) !== flight) {
            return
          }
          const currentLeaf = this.leaves.get(this.getLeafKey(leaf.tabId, leaf.leafId))
          if (!currentLeaf || currentLeaf.ptyId !== deliveryPtyId || !currentLeaf.writable) {
            return
          }
          this.ptyController?.write(deliveryPtyId, '\r')
        } catch {
          // Terminal may have closed during the delay; mail remains queued for check.
        } finally {
          // Why finally: every outcome — submit, refusal, throw — ends the flight,
          // and settle re-runs any trigger parked during it so nothing strands.
          this.settlePendingMessageDelivery(deliveryPtyId, flight)
        }
      }, 500)
      settlesInEnterCallback = true
    } finally {
      if (!settlesInEnterCallback) {
        this.settlePendingMessageDelivery(deliveryPtyId, flight)
      }
    }
  }
}
