import {
  PTY_CONSUMER_OWNER_HELD_ATTACHED_ERROR,
  PTY_CONSUMER_OWNER_HELD_DISCONNECTED_ERROR,
  PTY_CONSUMER_OWNER_HELD_SELF_ERROR,
  PTY_CONSUMER_OWNER_RECOVERY_PENDING_ERROR,
  PTY_CONSUMER_OWNER_RECOVERY_SUPERSEDED_ERROR
} from '../../shared/pty-consumer-session'

// Why: bound polling when publication is settling or a superseded attempt is closing its transport.
export const SSH_OWNER_RECOVERY_WAIT_MS = 3_000
// Why separate and longer than the relay's grace floor: a disconnected incumbent releases admission
// only after that floor elapses, so this budget must outlast it without borrowing the pending budget.
export const SSH_OWNER_HELD_DISCONNECTED_WAIT_MS = 2_000
// Why short: the incumbent is this client's own half-open connection, and the relay frees it when its
// keepalive notices — well outside any budget worth blocking a connect on. Poll briefly in case the
// close is already in flight, then let the ordinary relay-lost backoff carry the retry.
export const SSH_OWNER_HELD_SELF_WAIT_MS = 1_000

export type SshOwnerRecoveryRetryReason =
  | 'publication-pending'
  | 'disconnected-holder'
  | 'self-holder'

// Why exported: an attached holder is a decision, not a transport fault, so callers must be able to
// report it as blocked instead of feeding it to reconnect classification as an unexplained failure.
export function isSshOwnerAdmissionBlocked(error: unknown): boolean {
  return (
    (error as { code?: unknown } | null | undefined)?.code ===
    PTY_CONSUMER_OWNER_HELD_ATTACHED_ERROR
  )
}

function retryReasonFor(error: unknown): SshOwnerRecoveryRetryReason | null {
  const code = (error as { code?: unknown } | null | undefined)?.code
  if (
    code === PTY_CONSUMER_OWNER_RECOVERY_PENDING_ERROR ||
    code === PTY_CONSUMER_OWNER_RECOVERY_SUPERSEDED_ERROR
  ) {
    return 'publication-pending'
  }
  if (code === PTY_CONSUMER_OWNER_HELD_SELF_ERROR) {
    return 'self-holder'
  }
  // Why an attached holder is deliberately absent: it is blocked, not transient — retrying cannot
  // change the answer while another connection is live on the claim.
  return code === PTY_CONSUMER_OWNER_HELD_DISCONNECTED_ERROR ? 'disconnected-holder' : null
}
const SSH_OWNER_RECOVERY_INITIAL_DELAY_MS = 25
const SSH_OWNER_RECOVERY_MAX_DELAY_MS = 250

type SshOwnerRecoveryRetryGate = {
  isCurrent: () => boolean
  onClosed: (listener: () => void) => () => void
  onRetryExhausted?: (reason: SshOwnerRecoveryRetryReason) => void
}

function waitForRetry(delayMs: number, gate: SshOwnerRecoveryRetryGate): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe = (): void => {}
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      unsubscribe()
      resolve()
    }
    unsubscribe = gate.onClosed(finish)
    timer = setTimeout(finish, delayMs)
    timer.unref?.()
    if (!gate.isCurrent()) {
      finish()
    }
  })
}

export async function retrySshOwnerRecoveryWhileBlocked<T>(
  attempt: () => Promise<T>,
  gate: SshOwnerRecoveryRetryGate,
  waitMs: number = SSH_OWNER_RECOVERY_WAIT_MS
): Promise<T> {
  const budgetByReason: Record<SshOwnerRecoveryRetryReason, number> = {
    'publication-pending': waitMs,
    'disconnected-holder': SSH_OWNER_HELD_DISCONNECTED_WAIT_MS,
    'self-holder': SSH_OWNER_HELD_SELF_WAIT_MS
  }
  // Why each deadline starts when its own phase does: the phases are sequential and independent, so
  // charging one reason's budget for time another reason spent leaves it with nothing. A connect that
  // waits out a publication first would otherwise get zero attempts at the refusal that follows it.
  const deadlineByReason = new Map<SshOwnerRecoveryRetryReason, number>()
  let delayMs = SSH_OWNER_RECOVERY_INITIAL_DELAY_MS
  while (true) {
    try {
      return await attempt()
    } catch (error) {
      const reason = retryReasonFor(error)
      if (reason === null || !gate.isCurrent()) {
        throw error
      }
      let deadline = deadlineByReason.get(reason)
      if (deadline === undefined) {
        deadline = Date.now() + budgetByReason[reason]
        deadlineByReason.set(reason, deadline)
      }
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        gate.onRetryExhausted?.(reason)
        throw error
      }
      await waitForRetry(Math.min(delayMs, remainingMs), gate)
      if (!gate.isCurrent()) {
        throw error
      }
      delayMs = Math.min(delayMs * 2, SSH_OWNER_RECOVERY_MAX_DELAY_MS)
    }
  }
}
