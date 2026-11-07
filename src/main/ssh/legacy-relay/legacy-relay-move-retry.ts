/**
 * Finish a host move that waited on bridged relay terminals once the relay proves the last one
 * exited. Lost contact leaves panes unverifiable, so it never counts (#29626).
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 */
import type { LegacyRelayBridgeHost } from './legacy-relay-bridge-registry'

/** Targets whose bridge saw a relay-proven exit since its last pane publication. */
const exitedSincePublish = new Set<string>()
let lastExitListener: ((targetId: string) => void) | null = null
const retrying = new Set<string>()

export function onLastBridgedTerminalExit(listener: ((targetId: string) => void) | null): void {
  lastExitListener = listener
}

export function noteBridgedExit(targetId: string, host: Pick<LegacyRelayBridgeHost, 'report'>) {
  exitedSincePublish.add(targetId)
  host.report(targetId, 'terminal_exited', 0)
}

/** `servesNone`: no pane is left, live or unverifiable, and no closed tab's stop is owed. */
export function settleBridgedExits(targetId: string, servesNone: () => boolean): void {
  if (exitedSincePublish.delete(targetId) && servesNone()) {
    lastExitListener?.(targetId)
  }
}

export type BridgedMoveRetryDeps = {
  /** Connected, and unmoved only because the bridge served relay terminals. */
  waitingOnBridgedTerminals: (targetId: string) => boolean
  connectInFlight: (targetId: string) => Promise<unknown> | undefined
  /** A quiet automatic connect: refuses a disconnected host, keeps the host on refusal. */
  connect: (targetId: string) => Promise<unknown>
}

/** One retry at a time per target; resolves whether it ran. */
export async function retryMoveAfterLastBridgedExit(
  targetId: string,
  deps: BridgedMoveRetryDeps
): Promise<boolean> {
  if (retrying.has(targetId)) {
    return false
  }
  retrying.add(targetId)
  try {
    // A connect already running decides first; it may have moved the host itself.
    await deps.connectInFlight(targetId)?.catch(() => {})
    if (!deps.waitingOnBridgedTerminals(targetId)) {
      return false
    }
    await deps.connect(targetId)
    return true
  } catch (error) {
    console.warn(
      `[ssh] Could not finish the move for ${targetId} after its relay terminals:`,
      error
    )
    return false
  } finally {
    retrying.delete(targetId)
  }
}
