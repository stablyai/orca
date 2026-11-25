import { promptPublicationFor } from '../external-conversations/external-conversation-prompt-publication'
import {
  cloudConversation,
  type ConnectorEvent,
  type ConnectorPrompt
} from '../../shared/connectors/connector-cloud-contract'
import type {
  ConversationEvent,
  ConversationSnapshot
} from '../external-conversations/external-conversation-events'
import type {
  PromptPublication,
  PromptPublicationStatus
} from '../external-conversations/external-conversation-prompt-publication'

const key = (paneKey: string, conversation: unknown) => JSON.stringify([paneKey, conversation])
type Start = () => (status: PromptPublicationStatus) => void

/** Receipt callbacks stay off the wire and outlive a retired client only for their own occurrence. */
export class ConnectorPromptPublications {
  private readonly starts = new WeakMap<ConnectorEvent, Start[]>()

  bind(local: ConversationSnapshot | ConversationEvent, wire: ConnectorEvent): void {
    const starts: Start[] = []
    const add = (publication: PromptPublication | undefined, prompt: ConnectorPrompt | null) => {
      if (publication && prompt) {
        starts.push(() => publication.start(prompt))
      }
    }
    if (local.kind === 'snapshot' && wire.kind === 'snapshot') {
      const publications = new Map(
        local.conversations.map((entry) => [
          key(entry.paneKey, cloudConversation(entry.conversation)),
          promptPublicationFor(entry)
        ])
      )
      for (const entry of wire.conversations) {
        add(publications.get(key(entry.paneKey, entry.conversation)), entry.prompt)
      }
    } else if (local.kind === 'prompt' && wire.kind === 'prompt' && !wire.answered) {
      add(promptPublicationFor(local), wire.prompt)
    }
    if (starts.length) {
      this.starts.set(wire, starts)
    }
  }

  requestsFor(batch: readonly ConnectorEvent[]) {
    const starts = batch.flatMap((event) => this.starts.get(event) ?? [])
    if (!starts.length) {
      return undefined
    }
    let settled: ((status: PromptPublicationStatus) => void)[] = []
    return {
      started: () => {
        settled = starts.map((start) => start())
      },
      settled: (status: PromptPublicationStatus) => {
        for (const finish of settled) {
          finish(status)
        }
        settled = []
      }
    }
  }
}
