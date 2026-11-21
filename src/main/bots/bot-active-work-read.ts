// Reads a bot's live work for a turn its owner asked: open items and the work record, cached for a
// few seconds per bot, since the work record checks each worker it lists.
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { actsForOwner } from '../../shared/bots/bot-acts-for'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { readBotTurn } from '../runtime/rpc/methods/orchestration/messaging/bot-recipient'
import { type BotActiveWorkSection, botActiveWorkSection } from './bot-active-work'

const FRESH_MS = 15_000
/** Per status: needs_you is read on its own, so items in progress never push one off the page. */
const ITEMS_READ = 12

type Cached = { at: number; section: Promise<BotActiveWorkSection | null> }
const cache = new WeakMap<OrcaRuntimeService, Map<string, Cached>>()

/** The section for a turn of `sessionId`, a chat of `botId`; null unless the turn acts for the
 *  owner, or when nothing is live. */
export async function readBotActiveWork(
  runtime: OrcaRuntimeService,
  botId: string,
  sessionId: string,
  message: AgentJournalMessageItem,
  now = Date.now()
): Promise<BotActiveWorkSection | null> {
  const { turn } = await readBotTurn(runtime, runtime.getOrchestrationDb(), sessionId, message)
  if (!actsForOwner(turn.askers)) {
    return null
  }
  const bots = cache.get(runtime) ?? new Map<string, Cached>()
  cache.set(runtime, bots)
  const hit = bots.get(botId)
  if (hit && now - hit.at < FRESH_MS) {
    return hit.section
  }
  const section = (async () => {
    const read = (status: 'needs_you' | 'working') =>
      runtime.botItems.store().list({ botId, statuses: [status], limit: ITEMS_READ })
    const [needsYou, working, workers] = await Promise.all([
      read('needs_you'),
      read('working'),
      runtime.botWork.list(botId)
    ])
    const items = await runtime.botItems.views([...needsYou.items, ...working.items])
    return botActiveWorkSection(items, workers)
  })().catch(() => {
    // A failed read is tried again on the next turn, never kept.
    bots.delete(botId)
    return null
  })
  bots.set(botId, { at: now, section })
  return section
}
