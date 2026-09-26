// Why: a relaunching instance holds the preferred port for a moment; persisting an OS-assigned port for that race strands every device paired to ws://ip:<preferred> (STA-1511 companion). A real second instance holds it for its lifetime, so a bounded wait tells them apart.
export const PREFERRED_PORT_RETRY_MS = 3_000
const PREFERRED_PORT_RETRY_INTERVAL_MS = 250

// Why: only a busy port clears on its own; EACCES from a reserved range persists and must fall through.
function isPortBusyError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE'
}

export async function listenWithPortRetry(
  listen: () => Promise<void>,
  port: number,
  retryWindowMs: number
): Promise<void> {
  const deadline = Date.now() + retryWindowMs
  for (;;) {
    try {
      await listen()
      return
    } catch (error: unknown) {
      if (!isPortBusyError(error) || Date.now() >= deadline) {
        throw error
      }
      console.warn(`[ws-transport] Port ${port} is busy; retrying while a previous instance exits`)
      // Why: a full interval here would overshoot the caller's window by up to one tick.
      const delayMs = Math.min(PREFERRED_PORT_RETRY_INTERVAL_MS, deadline - Date.now())
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}
