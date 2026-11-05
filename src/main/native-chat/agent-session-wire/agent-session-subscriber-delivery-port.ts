import { finishJournalStepsAsync } from '../agent-session-journal/journal-reconstruction-steps'
import type {
  AgentSessionSlashCommand,
  AgentSessionSubscribeEvent,
  AgentSessionTurnActivity
} from '../../../shared/agent-session/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentSessionPublishedWork } from './agent-session-published-work'
import type { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import type { SubscriberFieldHooks } from './agent-session-subscriber-frame-fields'
import type { Subscriber } from './structured-agent-session-subscribers'
export type SubscriberDeliveryPort = {
  hooks: SubscriberFieldHooks & {
    isCurrentJournal?: (sessionId: string, journal: AgentSessionJournal) => boolean
    readCommands?: (sessionId: string) => AgentSessionSlashCommand[] | undefined
    readCurrentWork?: (
      sessionId: string,
      journal: AgentSessionJournal
    ) => StructuredAgentSessionCurrentWork | undefined
  }
  emit: (
    subscriber: Subscriber,
    event: AgentSessionSubscribeEvent,
    options?: {
      withholdQueued?: boolean
      journal?: AgentSessionJournal
      currentWork?: AgentSessionPublishedWork
      historyView?: string
    }
  ) => void
  emitSteps?: (
    ...args: Parameters<SubscriberDeliveryPort['emit']>
  ) => Generator<void, boolean | void>
  close?: (subscriber: Subscriber) => void
  isActive: (subscriber: Subscriber) => boolean
  activity: (sessionId: string) => AgentSessionTurnActivity | null
}

export async function emitSubscriberDelivery(
  port: SubscriberDeliveryPort,
  ...args: Parameters<SubscriberDeliveryPort['emit']>
): Promise<boolean | void> {
  if (port.emitSteps) {
    return finishJournalStepsAsync(port.emitSteps(...args))
  }
  port.emit(...args)
}
