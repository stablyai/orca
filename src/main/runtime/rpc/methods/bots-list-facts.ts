// What bots.list carries about each bot beyond its record: its waits still waiting, for its row's line,
// and its Needs you items that aren't stale, for its row and a phone's Items count (when they were
// counted and when the next goes stale, so a window orders this against an items notice's counts).
import { listBotWaits } from '../../../../shared/bots/bot-list-waits'
import type { OrcaRuntimeService } from '../../orca-runtime'

/** Needs you counts of the owner's own items, or with `teammate` theirs on their shared bot alone. */
export async function listedNeedsYouFacts(
  runtime: OrcaRuntimeService,
  teammate: { accountId: string; botId: string } | null = null
) {
  const needsYou = await runtime.botItems.needsYouCounts(Date.now(), teammate?.accountId ?? null)
  // A failed count says nothing, so a window keeps the counts it has.
  return needsYou
    ? {
        needsYou: teammate
          ? { [teammate.botId]: needsYou.counts[teammate.botId] ?? 0 }
          : needsYou.counts,
        needsYouAt: needsYou.at,
        ...(needsYou.staleInMs !== undefined ? { needsYouStaleInMs: needsYou.staleInMs } : {})
      }
    : {}
}

export async function listedBotsFacts(runtime: OrcaRuntimeService) {
  return {
    ...(await listedNeedsYouFacts(runtime)),
    waits: listBotWaits(runtime.listAutomationsForScope().automations, (ids) =>
      runtime.listAutomationRunsByAutomation(ids)
    )
  }
}
