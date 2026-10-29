import type { CloudDatabase } from '@orca-cloud/cloud-database'
import type { ConnectorConversation } from '@orca-cloud/connector-contract'
import type { ClaimedPost, PostBody } from './connector-posts.js'
import type { PlaceOption } from './machine-choice.js'
import type { AnswerablePrompt } from './owner-controls.js'
import type { SendOutcome } from './post-worker.js'

export type ConnectorSource = ConnectorConversation['source']

// Where a thread lives in its source, e.g. a Slack team, channel and thread ts.
export type ThreadPlace = { workspaceId: string; containerId: string; threadId: string }

// One person's message, as its source's ingress parsed it.
export type InboundMessage = {
  source: ConnectorSource
  place: ThreadPlace
  messageId: string
  authorId: string
  // The author's display name, where the source sends one with each message.
  authorName?: string
  // What the agent reads: the mention dropped, the source's escapes undone.
  text: string
  // Mentions Orca, or is a direct message to it.
  mentioned: boolean
  direct: boolean
  // The source or its workspace is paused: input is neither delivered nor kept.
  paused: boolean
}

// The one person a notice is meant for, where they wrote, and the message it answers (none for a
// button press).
export type NoticeTarget = {
  place: ThreadPlace
  userId: string
  direct: boolean
  messageId?: string
}

export type Notice =
  | { kind: 'paused' | 'unlinked' | 'update' | 'already_answered' }
  | { kind: 'ask'; options: PlaceOption[] }
  | { kind: 'only_owner'; ownerUserId: string }

// A conversation's state for its one status message, in precedence order (conversation-status.ts).
export type ConversationStatus =
  | { kind: 'offline' | 'working' | 'waiting' | 'unsupported' | 'unknown' | 'no_update' | 'done' }
  | { kind: 'needs_answer'; answerHere: boolean }
  | { kind: 'refused'; reason: string }

export type ConversationView = { hostName: string; ownerUserId: string; status: ConversationStatus }

// How a prompt card reads once it stops taking answers.
export type CardNote = { kind: 'closed' } | { kind: 'answered'; ownerUserId: string; label: string }

// What a source supplies to the shared core: post bodies in its own format, sending them, and
// reading its threads and members. Its ingress parses events and calls the core.
export type ConnectorAdapter = {
  source: ConnectorSource
  agentText(text: string): PostBody
  notice(target: NoticeTarget, notice: Notice): { kind: 'message' | 'ephemeral'; body: PostBody }
  // The acknowledgement on a message handed toward a machine.
  seen(place: ThreadPlace, messageId: string): PostBody
  status(view: ConversationView): PostBody
  // Null when the prompt can't be answered here; it is answered in Orca instead.
  card(prompt: AnswerablePrompt): PostBody | null
  isOpenCard(body: unknown): boolean
  settledCard(body: unknown, note: CardNote): PostBody
  // Agent-facing: teammates' messages ahead of the owner's next turn.
  teammateContext(lines: { name: string; text: string }[], ownerText: string): string
  send(post: ClaimedPost): Promise<SendOutcome>
  // A held start's prompt: the request plus the thread before it.
  heldStartPrompt(start: {
    place: ThreadPlace
    messageId: string
    request: string
  }): Promise<string>
  // Those of userIds confirmed trusted, with a display name where the source keeps one (null: the
  // name their message carried); nobody else's words reach an agent.
  trustedNames(
    transaction: CloudDatabase,
    workspaceId: string,
    userIds: string[]
  ): Promise<Map<string, string | null>>
}
