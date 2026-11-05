import { finishJournalStepsAsync } from '../agent-session-journal/journal-reconstruction-steps'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { Subscriber } from './structured-agent-session-subscribers'
import type { SubscriberDeliveryPort } from './agent-session-subscriber-catch-up'
import { readAgentSessionHydrationSteps } from './agent-session-history-page'
import { subscriberHistoryReader } from './agent-session-bounded-frames'
import { withPublishedWork } from './agent-session-published-work'
import { refreshPublishedWorkSteps } from './agent-session-work-refresh'
export async function deliverReplacement(
  port: SubscriberDeliveryPort,
  subscribers: Iterable<Subscriber>,
  journal: AgentSessionJournal,
  hostNow: number
): Promise<void> {
  for (const subscriber of subscribers) {
    const fence = subscriber.fence
    const reading = subscriber.cursor
    // New-context subscriptions already own an ordered hydration/catch-up.
    if (reading.epoch === journal.cursor().epoch) {
      continue
    }
    try {
      const { page, view, work } = await finishJournalStepsAsync(
        readAgentSessionHydrationSteps(
          journal,
          fence,
          subscriberHistoryReader(subscriber),
          undefined,
          () => port.hooks.readCurrentWork?.(subscriber.sessionId, journal)
        )
      )
      if (
        !port.isActive(subscriber) ||
        subscriber.fence !== fence ||
        port.hooks.isCurrentJournal?.(subscriber.sessionId, journal) === false ||
        journal.publicRead() !== view ||
        subscriber.cursor !== reading
      ) {
        continue
      }
      const shared = {
        sessionId: subscriber.sessionId,
        page: withPublishedWork(page, work),
        fence,
        hostNow
      }
      const emitted = await finishJournalStepsAsync(
        port.emitSteps!(
          subscriber,
          reading.epoch !== page.epoch
            ? { type: 'reset', reset: 'epoch_changed', ...shared }
            : { type: 'snapshot', ...shared },
          { currentWork: work, historyView: view.normalizationKey, journal }
        )
      )
      if (emitted === false) {
        continue
      }
      subscriber.cursor = page.liveCursor ?? page.window.nextCursor
      await finishJournalStepsAsync(
        refreshPublishedWorkSteps(port, subscriber, journal, work, { hostNow })
      )
    } catch (error) {
      console.warn('[agent-session-subscriber] replacement delivery failed', {
        sessionId: subscriber.sessionId,
        error
      })
      port.close?.(subscriber)
    }
  }
}
