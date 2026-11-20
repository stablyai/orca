import type { BotOwnedShare } from '../../../shared/bots/bot-share-status'
import { shareServesBot } from '../../../shared/bots/bot-share-status'
import type { SkillCloudOperation } from '../../../shared/skills/sharing/skill-cloud-contract'
import type { BotSharePicksStore } from './bot-share-picks-store'

/** Revokes the link; the named bot's picks go too, unless the list shows the link is another bot's. */
export async function stopBotShare(
  deps: {
    client: {
      listShares: () => Promise<SkillCloudOperation<BotOwnedShare[]>>
      revokeShare: (shareId: string) => Promise<SkillCloudOperation<boolean>>
    }
    picks?: BotSharePicksStore
  },
  shareId: string,
  botId?: string
): Promise<SkillCloudOperation<boolean>> {
  const shares = botId ? await deps.client.listShares().catch(() => null) : null
  const stopped = await deps.client.revokeShare(shareId)
  const own = shares?.status !== 'ok' || shareServesBot(shares.value, shareId, botId ?? '')
  if (stopped.status === 'ok' && botId && own) {
    await deps.picks?.forget(botId).catch(() => undefined)
  }
  return stopped
}
