// The two bounded waits an OMP RPC session handoff is gated on, split out of
// omp-rpc-session-owner.ts so the owner file stays inside its line budget.
// Both answer in the live/unverifiable/exited vocabulary the SSH execution
// boundary uses (docs/reference/ssh-execution-boundary.md): silence is never
// read as proof, it times out to `unverifiable` and the caller fails closed.

import type { OmpRpcSessionState, OmpSessionOwningRpcClient } from '../../shared/omp-rpc-protocol'

const OMP_RPC_SETTLE_TIMEOUT_MS = 10_000
const OMP_RPC_SETTLE_POLL_MS = 25
const OMP_RPC_EXIT_PROOF_TIMEOUT_MS = 5_000

export type OmpRpcOwnerExitVerdict =
  | { status: 'live'; reason: string }
  | { status: 'unverifiable'; reason: string }
  | { status: 'exited' }

/** `cause` is load-bearing, not diagnostics: a child that stopped answering
 *  may since have exited (the caller must reach the exit proof before
 *  deciding), while a turn that merely ran long is live work the caller must
 *  keep failing closed on. Collapsing both into "unverifiable" stranded a
 *  dead session's claim forever. */
export type OmpRpcSettleResult =
  | { status: 'settled' }
  | { status: 'unverifiable'; cause: 'state-unreadable' | 'timeout'; reason: string }

export function ompRpcErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isOmpRpcSessionSettled(state: OmpRpcSessionState): boolean {
  return !state.isStreaming && !state.isCompacting && state.queuedMessageCount === 0
}

export async function waitForOmpRpcSettle(
  client: OmpSessionOwningRpcClient
): Promise<OmpRpcSettleResult> {
  const deadline = Date.now() + OMP_RPC_SETTLE_TIMEOUT_MS
  // The deadline is checked AFTER each read, never before one: a clock-first
  // loop leaves the final poll interval unobserved, so a child that exited
  // during it was reported as a long turn (`timeout`) and never reached the
  // exit proof, stranding its claim. Every exit from here follows a fresh read.
  for (;;) {
    try {
      if (isOmpRpcSessionSettled(await client.getState())) {
        return { status: 'settled' }
      }
    } catch (error) {
      return {
        status: 'unverifiable',
        cause: 'state-unreadable',
        reason: ompRpcErrorMessage(error)
      }
    }
    if (Date.now() >= deadline) {
      return {
        status: 'unverifiable',
        cause: 'timeout',
        reason: 'OMP RPC session did not settle before timeout'
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, OMP_RPC_SETTLE_POLL_MS))
  }
}

export function proveOmpRpcExit(
  client: OmpSessionOwningRpcClient
): Promise<OmpRpcOwnerExitVerdict> {
  return new Promise((resolve) => {
    let isResolved = false
    const timer = setTimeout(() => {
      isResolved = true
      resolve({
        status: 'unverifiable',
        reason: 'OMP RPC child exit was not proven before timeout'
      })
    }, OMP_RPC_EXIT_PROOF_TIMEOUT_MS)
    timer.unref?.()
    void client.whenExited().then(
      () => {
        if (isResolved) {
          return
        }
        isResolved = true
        clearTimeout(timer)
        resolve({ status: 'exited' })
      },
      (error: unknown) => {
        if (isResolved) {
          return
        }
        isResolved = true
        clearTimeout(timer)
        resolve({ status: 'unverifiable', reason: ompRpcErrorMessage(error) })
      }
    )
  })
}
