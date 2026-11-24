// Replies and notices this computer's agents owe asks from a paired server's agents wait in its
// relay queue; it hands them back as soon as one is queued, since the server can't pull from here.
import { z } from 'zod'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { FederationRelayItemRow } from '../../db/orchestration-records'
import type { PairedServerAsks } from './paired-server-asks-pull'

const RETURN_TIMEOUT_MS = 15_000
const PAGE = 50

const Returned = z.object({
  acknowledgments: z.array(
    z.object({ conversationId: z.string(), throughSequence: z.number().int().nonnegative() })
  ),
  gone: z.array(z.string())
})

// Per server: a flush is running, the newest asks it was called with, and whether a wake landed
// while it ran.
type Flush = { asks: PairedServerAsks; again: boolean; done: Promise<void> }
const flushingByRuntime = new WeakMap<object, Map<string, Flush>>()
// Per server: the conversation the last full page ended on, so the next page can seek past it.
const startAfterByRuntime = new WeakMap<object, Map<string, string>>()

// The conversations a page draws from: those this server opened under this pairing (mail owed under
// an older one never goes to whatever answers now) that owe anything, in id order after `?3`. It
// seeks the owed list by pairing, so a page costs what it takes: never the conversations that owe
// nothing, nor another server's or pairing's backlog.
const OWING_SQL = `SELECT conversation_id FROM paired_server_owed_returns
  WHERE environment_id = ?1 AND peer_fingerprint = ?2 AND conversation_id > ?3
  ORDER BY conversation_id LIMIT ${PAGE}`

/** One page: each conversation's oldest owed rows, from the one after `startAfter`, round again. */
function pageOf(
  runtime: OrcaRuntimeService,
  asks: PairedServerAsks,
  startAfter: string
): FederationRelayItemRow[] {
  const db = runtime.getOrchestrationDb()
  const owing = (after: string) =>
    db.db
      .prepare(OWING_SQL)
      .all(asks.environmentId, asks.pairing, after)
      .map((row) => String(row.conversation_id))
  const later = owing(startAfter)
  const conversations =
    later.length < PAGE && startAfter !== ''
      ? [...later, ...owing('').filter((id) => id <= startAfter)].slice(0, PAGE)
      : later
  const items: FederationRelayItemRow[] = []
  for (const conversationId of conversations) {
    if (items.length === PAGE) {
      break
    }
    items.push(...db.listPendingFederationRelay(conversationId, 'to_home', PAGE - items.length))
  }
  return items
}

/** One page to the server; true when a full page made progress, so more may be waiting. */
async function returnPage(runtime: OrcaRuntimeService, asks: PairedServerAsks): Promise<boolean> {
  const db = runtime.getOrchestrationDb()
  const startAfter = startAfterByRuntime.get(runtime) ?? new Map<string, string>()
  startAfterByRuntime.set(runtime, startAfter)
  const items = pageOf(runtime, asks, startAfter.get(asks.environmentId) ?? '')
  if (items.length === 0) {
    startAfter.delete(asks.environmentId)
    return false
  }
  const returned = Returned.parse(
    await runtime.callOrchestrationWorkerServer(
      asks.environmentId,
      'orchestration.peerMailReturn',
      {
        items: items.map((item) => ({
          conversationId: item.dispatch_id,
          sequence: item.sequence,
          messageId: item.message_id,
          kind: item.kind,
          payload: item.payload
        }))
      },
      RETURN_TIMEOUT_MS,
      undefined,
      // Refused before it is sent if the pairing was replaced since this page was chosen.
      { expectedEnvironmentPairingRevision: asks.pairingRevision }
    )
  )
  // Only what this page sent can be acknowledged: an ack past it, or for another conversation,
  // would settle mail the server never received.
  const sent = new Map<string, { first: number; last: number }>()
  for (const item of items) {
    const range = sent.get(item.dispatch_id)
    sent.set(item.dispatch_id, {
      first: Math.min(range?.first ?? item.sequence, item.sequence),
      last: Math.max(range?.last ?? item.sequence, item.sequence)
    })
  }
  let progressed = false
  const acknowledge = (conversationId: string, throughSequence: number): void => {
    const range = sent.get(conversationId)
    if (range !== undefined && throughSequence >= range.first) {
      progressed = true
      db.acknowledgeFederationRelay({
        dispatchId: conversationId,
        direction: 'to_home',
        throughSequence: Math.min(throughSequence, range.last)
      })
    }
  }
  for (const ack of returned.acknowledgments) {
    acknowledge(ack.conversationId, ack.throughSequence)
  }
  // A conversation the server no longer has under this pairing: its askers were told there.
  for (const conversationId of returned.gone) {
    acknowledge(conversationId, Number.MAX_SAFE_INTEGER)
  }
  if (items.length < PAGE) {
    startAfter.delete(asks.environmentId)
  } else {
    startAfter.set(asks.environmentId, items.at(-1)!.dispatch_id)
  }
  // A page the server took none of waits for the next wake or pull, never sent again at once.
  return items.length === PAGE && progressed
}

/** Hands back what is owed now; a failure leaves it queued for the next wake or pull. A call while
 *  one runs makes it page again, and resolves when it ends. */
export function flushPairedServerReturns(
  runtime: OrcaRuntimeService,
  asks: PairedServerAsks
): Promise<void> {
  const flushing = flushingByRuntime.get(runtime) ?? new Map<string, Flush>()
  flushingByRuntime.set(runtime, flushing)
  const running = flushing.get(asks.environmentId)
  if (running) {
    running.asks = asks
    running.again = true
    return running.done
  }
  const state: Flush = { asks, again: true, done: Promise.resolve() }
  flushing.set(asks.environmentId, state)
  state.done = (async () => {
    try {
      while (state.again) {
        state.again = false
        const current = state.asks
        try {
          if (await returnPage(runtime, current)) {
            state.again = true
          }
        } catch (error) {
          console.warn(`[orchestration] Returning replies to ${current.serverName} failed:`, error)
          // Newer asks came while it failed (a replaced pairing): they page; else the next wake does.
          if (state.asks === current) {
            break
          }
          state.again = true
        }
      }
    } finally {
      flushing.delete(asks.environmentId)
    }
  })()
  return state.done
}
