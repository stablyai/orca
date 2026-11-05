import { finishJournalStepsAsync } from '../agent-session-journal/journal-reconstruction-steps'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { Subscriber } from './structured-agent-session-subscribers'
import type { SubscriberDeliveryPort } from './agent-session-subscriber-catch-up'
import { readAgentSessionHydration } from './agent-session-history-page'
import { subscriberHistoryReader } from './agent-session-bounded-frames'
import { withPublishedWork } from './agent-session-published-work'
import { refreshPublishedWork, refreshPublishedWorkSteps } from './agent-session-work-refresh'
import { queueSubscriberDelivery } from './agent-session-subscriber-delivery'
export function hydrateSubscriber(
  port: SubscriberDeliveryPort,
  subscriber: Subscriber,
  journal: AgentSessionJournal,
  hostNow: number,
  prepared = readAgentSessionHydration(
    journal,
    subscriber.fence,
    subscriberHistoryReader(subscriber),
    undefined,
    () => port.hooks.readCurrentWork?.(subscriber.sessionId, journal)
  )
): void {
  const fence = subscriber.fence
  const reading = { ...subscriber.cursor }
  const publish = async ({ page, view, work }: Awaited<typeof prepared>) => {
    if (
      !port.isActive(subscriber) ||
      subscriber.fence !== fence ||
      port.hooks.isCurrentJournal?.(subscriber.sessionId, journal) === false
    ) {
      return
    }
    if (
      (prepared instanceof Promise && journal.publicRead() !== view) ||
      subscriber.cursor.epoch !== reading.epoch ||
      subscriber.cursor.sequence !== reading.sequence
    ) {
      queueSubscriberDelivery(
        port,
        subscriber,
        { journal, hostNow, emitCheckpoint: true },
        () => {}
      )
      return
    }
    const args: Parameters<SubscriberDeliveryPort['emit']> = [
      subscriber,
      {
        type: 'snapshot',
        sessionId: subscriber.sessionId,
        page: withPublishedWork(page, work),
        fence,
        hostNow,
        activity: port.activity(subscriber.sessionId)
      },
      { currentWork: work, historyView: view.normalizationKey, journal }
    ]
    if (prepared instanceof Promise && port.emitSteps) {
      if ((await finishJournalStepsAsync(port.emitSteps(...args))) === false) {
        return
      }
    } else {
      port.emit(...args)
    }
    subscriber.cursor = page.liveCursor ?? page.window.nextCursor
    if (prepared instanceof Promise) {
      await finishJournalStepsAsync(
        refreshPublishedWorkSteps(port, subscriber, journal, work, { hostNow })
      )
    } else {
      refreshPublishedWork(port, subscriber, journal, work, { hostNow })
    }
  }
  if (prepared instanceof Promise) {
    void prepared.then(publish).catch(() => port.close?.(subscriber))
  } else {
    void publish(prepared)
  }
}
