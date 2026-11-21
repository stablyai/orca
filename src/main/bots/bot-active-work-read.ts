// Reads a bot's live work for a turn its owner asked: open items and the work record, cached for a
// minute per bot, since the work record checks each worker it lists.
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { actsForOwner } from '../../shared/bots/bot-acts-for'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { readBotTurn } from '../runtime/rpc/methods/orchestration/messaging/bot-recipient'
import { type BotActiveWorkSection, botActiveWorkSection } from './bot-active-work'

const FRESH_MS = 60_000
const ITEMS_READ = 50

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
    const page = await runtime.botItems
      .store()
      .list({ botId, statuses: ['needs_you', 'working'], limit: ITEMS_READ })
    const [items, workers] = await Promise.all([
      runtime.botItems.views(page.items),
      runtime.botWork.list(botId)
    ])
    return botActiveWorkSection(items, workers)
  })().catch(() => null)
  bots.set(botId, { at: now, section })
  return section
}
