import type { CodexAppServerConnection } from '../codex-app-server-connection-types'
import type { CodexSharedServerLease } from './codex-shared-server-lease'
import type { CodexSharedServerTurns } from './codex-shared-server-turns'

/** How long an interrupted turn has to report turn/completed before Stop counts it unproven. */
const TURN_STOP_PROOF_MS = 10_000

/** Interrupts every turn on the chat's threads, the helpers it announces meanwhile included;
 *  the chat keeps routing them until each turn is proven over. */
export async function stopCodexLeaseWriter(
  physical: Pick<CodexAppServerConnection, 'request'>,
  lease: CodexSharedServerLease,
  turns: CodexSharedServerTurns,
  requestTimeoutMs: number
): Promise<boolean> {
  const options = { timeoutMs: requestTimeoutMs }
  // Opens that answer from here on are abandoned (lease.ts), so none outlives the chat.
  await turns.waitUntil(
    () => lease.pendingOpens.size === 0 && !turns.anyStartPending([...lease.threads]),
    requestTimeoutMs
  )
  // Shared with earlier attempts, so a retry never interrupts the same turn twice.
  const interrupted = lease.interruptedTurns
  for (let pass = 0; pass < 2; pass += 1) {
    const running = [...lease.threads, ...lease.abandonedThreads].flatMap((threadId) => {
      const turnId = turns.runningOn(threadId)
      return turnId && !interrupted.has(turnId) ? [{ threadId, turnId }] : []
    })
    await Promise.all(
      running.map(async ({ threadId, turnId }) => {
        interrupted.add(turnId)
        const ended = turns.waitUntil(
          () => turns.runningOn(threadId) !== turnId,
          requestTimeoutMs + TURN_STOP_PROOF_MS
        )
        // Unsent or refused, so a retry interrupts it again.
        await physical
          .request('turn/interrupt', { threadId, turnId }, options)
          .catch(() => interrupted.delete(turnId))
        await ended
      })
    )
  }
  const threads = [...lease.threads, ...lease.abandonedThreads]
  return (
    lease.pendingOpens.size === 0 &&
    !turns.anyStartPending(threads) &&
    threads.every((threadId) => turns.runningOn(threadId) === undefined)
  )
}
