// What orchestration's own records say about workers started for items: the item a Dispatch was
// started for (`worker-start --item`), the chat that started it, and a Dispatch's lineage.
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import type { BotItemLinkInput } from './bot-items-input'
import {
  lineageLiveSession,
  readAgentSessionRecordStore
} from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'

const ORIGIN_PREFIX = 'bot-item:'

/** The item a Dispatch was started for (a retry or follow-up keeps its earlier start's). */
export function dispatchItemUid(db: OrchestrationDb, dispatchId: string): string | null {
  const ref = db.getDispatchContextById(dispatchId)?.origin_ref ?? null
  return ref?.startsWith(ORIGIN_PREFIX) ? ref.slice(ORIGIN_PREFIX.length) : null
}

/** A Dispatch and the ones it follows up, newest first. */
export function lineageAncestors(db: OrchestrationDb, dispatchId: string): string[] {
  const seen: string[] = []
  let id: string | null = dispatchId
  while (id && !seen.includes(id) && seen.length < 100) {
    seen.push(id)
    id = db.getDispatchContextById(id)?.follow_up_of_dispatch_id ?? null
  }
  return seen
}

/** The first Dispatch of the follow-up chain a Dispatch belongs to: every step of one worker shares it. */
function dispatchChainRoot(db: OrchestrationDb, dispatchId: string): string {
  return lineageAncestors(db, dispatchId).at(-1) ?? dispatchId
}

/** The links worth adding: a Dispatch on a follow-up chain already linked (or linked earlier in the
 *  same list) is that worker again. */
export function linksOutsideLinkedChains(
  db: OrchestrationDb,
  linked: readonly BotItemLinkInput[],
  links: readonly BotItemLinkInput[]
): BotItemLinkInput[] {
  const chains = new Set(
    linked.flatMap((link) => (link.kind === 'dispatch' ? [dispatchChainRoot(db, link.ref)] : []))
  )
  return links.filter((link) => {
    if (link.kind !== 'dispatch') {
      return true
    }
    const chain = dispatchChainRoot(db, link.ref)
    const known = chains.has(chain)
    chains.add(chain)
    return !known
  })
}

/** The chat whose worker-start made a Dispatch: its live session, and the chat id its writes keep. */
export function dispatchStarter(
  db: OrchestrationDb,
  dispatchId: string,
  chatRoot: (sessionId: string) => string
): { sessionId: string; chatId: string } | null {
  const creator = db.getDispatchContextById(dispatchId)?.creator_orca_session_id
  const records = creator ? readAgentSessionRecordStore() : null
  const live = creator && records ? lineageLiveSession(records, creator) : null
  return creator && live ? { sessionId: live.sessionId, chatId: chatRoot(creator) } : null
}
