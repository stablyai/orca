import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import {
  buildSubscriberFrame,
  type SubscriberFieldHooks
} from './agent-session-subscriber-frame-fields'
import type { Subscriber } from './structured-agent-session-subscribers'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export function resumeSubscriberOutput(input: {
  subscriber: Subscriber
  readJournal?: (sessionId: string) => Promise<AgentSessionJournal>
  active: () => boolean
  ready: (journal: AgentSessionJournal) => void
  drop: () => void
}): void {
  const { subscriber } = input
  if (!subscriber.pendingOutput) {
    return
  }
  // Why: a live reader must not pin an idle fold; reopen through its execution host when ready.
  if (input.readJournal) {
    subscriber.outputBlocked = true
    void input
      .readJournal(subscriber.sessionId)
      .then((journal) => {
        if (input.active()) {
          subscriber.journal = new WeakRef(journal)
          subscriber.outputBlocked = undefined
          input.ready(journal)
        }
      })
      .catch(input.drop)
  } else {
    const journal = subscriber.journal.deref()
    if (journal) {
      input.ready(journal)
    } else {
      input.drop()
    }
  }
}

export function emitSubscriberFrame(input: {
  hooks: SubscriberFieldHooks
  subscriber: Subscriber
  event: AgentSessionSubscribeEvent
  withholdQueued: boolean
  active: () => boolean
  ready: () => void
  drop: () => void
}): void {
  const { subscriber } = input
  if (subscriber.outputBlocked) {
    subscriber.pendingOutput = true
    return
  }
  try {
    const built = buildSubscriberFrame(input.hooks, subscriber, input.event, input.withholdQueued)
    const sent = (): void => {
      subscriber.commands = built.commands
      if (built.attachedQueued) {
        subscriber.queuePublication = built.queued
      }
      if (built.backgroundTasks !== undefined) {
        subscriber.backgroundTasks = built.backgroundTasks
      }
    }
    const delivery: unknown = subscriber.emit(built.frame)
    if (subscriber.queueView && delivery instanceof Promise) {
      subscriber.outputBlocked = true
      void delivery
        .then(() => {
          if (!input.active()) {
            return
          }
          sent()
          subscriber.outputBlocked = undefined
          input.ready()
        })
        .catch(input.drop)
    } else {
      sent()
    }
  } catch {
    input.drop()
  }
}
