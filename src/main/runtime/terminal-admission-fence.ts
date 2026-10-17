/**
 * The window between an update's last terminal census and the stop that follows it (R32): while
 * closed, this server starts no new terminal, so the census stays true until the stop.
 * Process-wide on purpose: the stop it guards ends the whole server.
 */
let closedUntilMs = 0

export class TerminalAdmissionClosedError extends Error {
  constructor() {
    super('This server is restarting for an update. Try again in a moment.')
    this.name = 'TerminalAdmissionClosedError'
  }
}

/** Closes admission for `durationMs` (0 reopens) and returns when it reopens on its own. */
export function closeTerminalAdmission(durationMs: number, now = Date.now()): number {
  closedUntilMs = durationMs > 0 ? now + durationMs : 0
  return closedUntilMs
}

export function isTerminalAdmissionClosed(now = Date.now()): boolean {
  return closedUntilMs > now
}

let spawnsInFlight = 0
let settledWaiters: (() => void)[] = []

/**
 * Runs a terminal spawn as in flight, rechecking admission at its start: preflight admits it
 * before slow setup, and a census that closes admission meanwhile must either see it or refuse it.
 */
export async function runAdmittedTerminalSpawn<T>(
  check: () => Promise<void> | void,
  spawn: () => Promise<T>
): Promise<T> {
  spawnsInFlight += 1
  try {
    await check()
    return await spawn()
  } finally {
    spawnsInFlight -= 1
    if (spawnsInFlight === 0) {
      const waiters = settledWaiters
      settledWaiters = []
      for (const resolve of waiters) {
        resolve()
      }
    }
  }
}

/** Whether every spawn admitted before the fence finished within `timeoutMs`. */
export function waitForTerminalSpawnsToSettle(timeoutMs: number): Promise<boolean> {
  if (spawnsInFlight === 0) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      settledWaiters = settledWaiters.filter((waiter) => waiter !== settle)
      resolve(false)
    }, timeoutMs)
    const settle = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    settledWaiters.push(settle)
  })
}
