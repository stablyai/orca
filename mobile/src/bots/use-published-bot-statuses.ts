import { useEffect } from 'react'
import type { BotRowStatus } from '../../../src/shared/bots/bot-row-status'
import type { Section } from '../worktree/workspace-list/workspace-list-types'
import type { HostBotListing } from './host-bot-sections'
import { publishHostBotStatuses } from './host-bot-store'
import { hostBotsKey } from './host-bots-read'

/** Hands each bot's rolled-up row status to its home's header, so both show one state. */
export function usePublishedBotStatuses(
  pairedHostId: string | undefined,
  bots: readonly HostBotListing[],
  sections: readonly Section[]
): void {
  useEffect(() => {
    if (!pairedHostId) {
      return
    }
    const byKey = new Map(
      bots.map((listing) => [
        hostBotsKey(pairedHostId, listing.hostId),
        new Map<string, BotRowStatus>()
      ])
    )
    for (const { row, view } of sections.flatMap((section) => section.data)) {
      if (view.botFacts) {
        byKey
          .get(hostBotsKey(pairedHostId, row.hostId))
          ?.set(view.botFacts.botId, view.botFacts.status)
      }
    }
    byKey.forEach((statuses, key) => publishHostBotStatuses(key, statuses))
    // A row the list no longer draws leaves its header to read the home's own chats.
    return () => byKey.forEach((_, key) => publishHostBotStatuses(key, new Map()))
  }, [pairedHostId, bots, sections])
}
