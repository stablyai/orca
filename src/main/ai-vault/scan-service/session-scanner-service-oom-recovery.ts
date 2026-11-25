import type { ChildProcess } from 'node:child_process'
import {
  rejectAiVaultServiceCall,
  type AiVaultServicePendingCall
} from './session-scanner-service-client-state'
import { recordAiVaultServiceExit } from './session-scanner-service-exit'

/** Holds a faulted child's scans until its exit says whether it ran out of heap, then reruns them once. */
export class AiVaultServiceOutOfMemoryRecovery {
  private ranOutOfMemory = false
  private readonly awaitingExit = new Set<AiVaultServicePendingCall>()
  // Set from a fault until the dead child says whether it ran out of heap; the next spawn needs that.
  private exitVerdict: PromiseWithResolvers<void> | null = null

  get afterOutOfMemory(): boolean {
    return this.ranOutOfMemory
  }

  get pendingVerdict(): Promise<void> | null {
    return this.exitVerdict?.promise ?? null
  }

  /** Returns the faulted calls that were not held, for the caller to retry or reject now. */
  onFault(
    child: ChildProcess,
    error: Error,
    active: AiVaultServicePendingCall[],
    retire: boolean,
    queue: AiVaultServicePendingCall[],
    onSettled: () => void
  ): AiVaultServicePendingCall[] {
    // A scan that exhausted the heap would exhaust it again; hold it until the exit says why.
    // Retired children were alive at the fault; one that runs out of heap while retiring is not rerun.
    const held =
      this.ranOutOfMemory || retire
        ? []
        : active.filter((call) => call.sent && call.request.operation === 'scan')
    for (const call of held) {
      this.awaitingExit.add(call)
    }
    const verdict = retire ? null : Promise.withResolvers<void>()
    this.exitVerdict = verdict ?? this.exitVerdict
    recordAiVaultServiceExit(child, error, (outOfMemory) => {
      this.ranOutOfMemory ||= outOfMemory
      if (verdict) {
        if (this.exitVerdict === verdict) {
          this.exitVerdict = null
        }
        verdict.resolve()
      }
      for (const call of held.toReversed()) {
        if (!this.awaitingExit.delete(call)) {
          continue
        }
        if (outOfMemory && !call.cancelled) {
          // The replacement child never saw this request; cancelling it there must not await an ack.
          call.sent = false
          queue.unshift(call)
        } else {
          rejectAiVaultServiceCall(call, error)
        }
      }
      onSettled()
    })
    return active.filter((call) => !held.includes(call))
  }

  rejectAll(error: Error): void {
    for (const call of this.awaitingExit) {
      rejectAiVaultServiceCall(call, error)
    }
    this.awaitingExit.clear()
    this.exitVerdict?.resolve()
    this.exitVerdict = null
  }
}
