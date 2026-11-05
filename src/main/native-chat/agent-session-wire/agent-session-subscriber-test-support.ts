import type { AgentSessionSubscribers } from './structured-agent-session-subscribers'

/** Join real queued deliveries without adding a production wait to a foreground command. */
export async function settleTestSubscriberDeliveries(
  subscribers: AgentSessionSubscribers
): Promise<void> {
  for (;;) {
    const pending: Promise<void>[] = []
    subscribers['bySession'].forEach((session) => {
      session.forEach((subscriber) => {
        if (subscriber.delivery) {
          pending.push(subscriber.delivery)
        }
      })
    })
    if (!pending.length) {
      return
    }
    await Promise.all(pending)
  }
}
