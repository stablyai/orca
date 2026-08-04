import {
  PTY_CONSUMER_OWNER_RECOVERY_PENDING_ERROR,
  PTY_CONSUMER_OWNER_RECOVERY_SUPERSEDED_ERROR
} from '../../shared/pty-consumer-session'

// Why: bound polling when publication is settling or a superseded attempt is closing its transport.
export const SSH_OWNER_RECOVERY_WAIT_MS = 3_000
const SSH_OWNER_RECOVERY_INITIAL_DELAY_MS = 25
const SSH_OWNER_RECOVERY_MAX_DELAY_MS = 250

type SshOwnerRecoveryRetryGate = {
  isCurrent: () => boolean
  onClosed: (listener: () => void) => () => void
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
  const deadline = Date.now() + waitMs
  let delayMs = SSH_OWNER_RECOVERY_INITIAL_DELAY_MS
  while (true) {
    try {
      return await attempt()
    } catch (error) {
      const code = (error as { code?: unknown } | null | undefined)?.code
      if (
        (code !== PTY_CONSUMER_OWNER_RECOVERY_PENDING_ERROR &&
          code !== PTY_CONSUMER_OWNER_RECOVERY_SUPERSEDED_ERROR) ||
        !gate.isCurrent()
      ) {
        throw error
      }
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
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
