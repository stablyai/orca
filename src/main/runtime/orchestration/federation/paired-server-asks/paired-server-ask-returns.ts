// Replies and notices this computer's agents owe asks from a paired server's agents wait in its
// relay queue; it hands them back as soon as one is queued, since the server can't pull from here.
import { z } from 'zod'
import { lazyZodSchema } from '../../../../../shared/schema/lazy-zod-schema'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { PairedServerAsks } from './paired-server-asks-pull'

const RETURN_TIMEOUT_MS = 15_000
const PAGE = 50

const Returned = lazyZodSchema(() =>
  z.object({
    acknowledgments: z.array(
      z.object({ conversationId: z.string(), throughSequence: z.number().int().nonnegative() })
    ),
    gone: z.array(z.string())
  })
)

// Per server: a flush is running, and whether a wake landed while it ran.
type Flush = { again: boolean; done: Promise<void> }
const flushingByRuntime = new WeakMap<object, Map<string, Flush>>()

const OWED_SQL = `SELECT DISTINCT c.conversation_id FROM peer_mail_conversations c
  JOIN federation_relay_items i ON i.dispatch_id = c.conversation_id
  WHERE c.role = 'peer' AND c.environment_id = ? AND i.direction = 'to_home' AND i.acked_at IS NULL
  ORDER BY c.conversation_id`

/** One page to the server; true when more may be waiting. */
async function returnPage(runtime: OrcaRuntimeService, asks: PairedServerAsks): Promise<boolean> {
  const db = runtime.getOrchestrationDb()
  const conversations = db.db
    .prepare(OWED_SQL)
    .all(asks.environmentId)
    .map((row) => String(row.conversation_id))
  const items = conversations
    .flatMap((id) => db.listPendingFederationRelay(id, 'to_home', PAGE))
    .slice(0, PAGE)
  if (items.length === 0) {
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
      RETURN_TIMEOUT_MS
    )
  )
  for (const ack of returned.acknowledgments) {
    db.acknowledgeFederationRelay({
      dispatchId: ack.conversationId,
      direction: 'to_home',
      throughSequence: ack.throughSequence
    })
  }
  // A conversation the server no longer has under this pairing: its askers were told there.
  for (const conversationId of returned.gone) {
    const through = Math.max(
      ...items.filter((item) => item.dispatch_id === conversationId).map((item) => item.sequence)
    )
    db.acknowledgeFederationRelay({
      dispatchId: conversationId,
      direction: 'to_home',
      throughSequence: through
    })
  }
  return items.length === PAGE
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
    running.again = true
    return running.done
  }
  const state: Flush = { again: true, done: Promise.resolve() }
  flushing.set(asks.environmentId, state)
  state.done = (async () => {
    try {
      while (state.again) {
        state.again = false
        if (await returnPage(runtime, asks)) {
          state.again = true
        }
      }
    } catch (error) {
      console.warn(`[orchestration] Returning replies to ${asks.serverName} failed:`, error)
    } finally {
      flushing.delete(asks.environmentId)
    }
  })()
  return state.done
}
