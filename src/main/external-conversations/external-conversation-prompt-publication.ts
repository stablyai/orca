import type { ConnectorPrompt } from '../../shared/connectors/connector-cloud-contract'
import type { ConversationEvent, ConversationSnapshot } from './external-conversation-events'

export type PromptPublicationStatus = number | 'network' | 'aborted'
export type PromptPublication = {
  start(prompt: ConnectorPrompt): (status: PromptPublicationStatus) => void
}

type PromptPublicationSource =
  | Extract<ConversationEvent, { kind: 'prompt' }>
  | ConversationSnapshot['conversations'][number]

const publications = new WeakMap<PromptPublicationSource, PromptPublication>()

/** Receipt plumbing stays outside watch data and the wire representation. */
export function setPromptPublication(
  local: PromptPublicationSource,
  publication: PromptPublication
): void {
  publications.set(local, publication)
}

export function promptPublicationFor(
  local: PromptPublicationSource
): PromptPublication | undefined {
  return publications.get(local)
}
