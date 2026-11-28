import { mapSettledWithConcurrency } from '../../../../shared/concurrency/map-with-concurrency'
import type { CodexAppServerConnection } from '../codex-app-server-connection-types'
import { readRecord } from '../codex-item-field-readers'
import { readCodexTurnStatus } from '../codex-structured-thread-facts'
import type { CodexSharedServerLease } from './codex-shared-server-lease'
import type { CodexSharedServerTurns } from './codex-shared-server-turns'
import { listCodexLoadedThreads } from './codex-shared-server-open-work'

/** How long an interrupted turn has to report turn/completed before Stop counts it unproven. */
const TURN_STOP_PROOF_MS = 10_000

type Reads = Pick<CodexAppServerConnection, 'request'>

/** Turns that started before this app attached are in no notification it read: each thread with
 *  none known is read, and a running one noted. False when a read failed (its state is unknown). */
export async function seedRunningCodexTurns(
  reads: Reads,
  threads: Iterable<string>,
  turns: CodexSharedServerTurns,
  timeoutMs: number
): Promise<boolean> {
  const unknown = [...threads].filter((threadId) => turns.runningOn(threadId) === undefined)
  const settled = await mapSettledWithConcurrency(unknown, 4, async (threadId) => {
    const page = readRecord(
      await reads.request(
        'thread/turns/list',
        { threadId, sortDirection: 'desc', limit: 1 },
        { timeoutMs }
      )
    )
    const turn = readRecord(Array.isArray(page.data) ? page.data[0] : null)
    if (typeof turn.id === 'string' && readCodexTurnStatus(turn) === 'inProgress') {
      turns.noteStarted(threadId, turn.id)
    }
  })
  return settled.every((read) => read.status === 'fulfilled')
}

/** Marks the chat's threads the server has loaded as live. A failed listing marks none and leaves
 *  the chat's workload unproven (Stop reports it), rather than retrying reads that can't succeed. */
async function markLoadedThreadsLive(reads: Reads, lease: CodexSharedServerLease): Promise<true> {
  const loaded = await listCodexLoadedThreads(reads).catch(() => null)
  lease.helpersUnread = loaded === null
  for (const threadId of lease.threads) {
    if (loaded?.has(threadId)) {
      lease.liveThreads.add(threadId)
    }
  }
  return true
}

/** Interrupts every turn on the chat's threads, the helpers it announces meanwhile included;
 *  the chat keeps routing them until each turn is proven over. */
export async function stopCodexLeaseWriter(
  physical: Pick<CodexAppServerConnection, 'request'>,
  lease: CodexSharedServerLease,
  turns: CodexSharedServerTurns,
  requestTimeoutMs: number,
  /** The server's shared, limited reads, for a restored chat's turns. */
  reads: Reads = physical
): Promise<boolean> {
  const options = { timeoutMs: requestTimeoutMs }
  // A kept run's helpers came back through history, not live frames: those still loaded here may
  // run (a quiet one sends nothing), so they're stopped like live ones.
  const seeded =
    !lease.restored ||
    ((await markLoadedThreadsLive(reads, lease)) &&
      (await seedRunningCodexTurns(reads, lease.liveThreads, turns, requestTimeoutMs)))
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
        // Unsent or refused: the next Stop sends it again.
        await physical.request('turn/interrupt', { threadId, turnId }, options).then(
          () => lease.refusedInterrupts.delete(turnId),
          () => {
            interrupted.delete(turnId)
            lease.refusedInterrupts.add(turnId)
          }
        )
        await ended
      })
    )
  }
  const threads = [...lease.threads, ...lease.abandonedThreads]
  return (
    seeded &&
    lease.pendingOpens.size === 0 &&
    !turns.anyStartPending(threads) &&
    threads.every((threadId) => turns.runningOn(threadId) === undefined)
  )
}
