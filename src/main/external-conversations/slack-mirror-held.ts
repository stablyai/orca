// A turn's reply held until the owner's posts of that turn are in the Slack thread (or dismissed),
// kept on the chat's link so a restart still posts it.
import * as z from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import {
  CONNECTOR_TURN_ORIGINS,
  ConnectorFailure
} from '../../shared/connectors/connector-cloud-contract'
import { ConnectorWorkLink } from '../../shared/connector-work-link-contract'
import {
  CONNECTOR_SOURCES,
  type ExternalConversationLink,
  type SlackMirrorHeld
} from '../../shared/connectors/external-conversation-link'
import { AGENT_TURN_OUTCOMES } from '../../shared/agent-status/lifecycle/agent-turn-outcome'
import type { ConversationEvent } from './external-conversation-events'

export type ConversationTurnEnd = Extract<ConversationEvent, { kind: 'turn-ended' }>

const HeldTurnEnd = lazyZodSchema(() =>
  z.object({
    kind: z.literal('turn-ended'),
    conversation: z.object({ source: z.enum(CONNECTOR_SOURCES), externalId: z.string() }),
    worktreeId: z.string(),
    paneKey: z.string(),
    turnId: z.number().nullable(),
    stopReason: z.enum(AGENT_TURN_OUTCOMES).nullable(),
    at: z.number(),
    lastAssistantMessage: z.string().optional(),
    origin: z.enum(CONNECTOR_TURN_ORIGINS).optional(),
    failure: ConnectorFailure.optional(),
    links: z.array(ConnectorWorkLink).optional(),
    mirror: z.literal(true).optional(),
    // Whom the turn acts for, decided when it ended: kept across the hold, never decided again.
    turnFor: z.enum(['owner', 'someone_else', 'none']).optional()
  })
)

/** The owner's posts a reply still waits for: those posting or failed. */
export function postsWaiting(
  link: Pick<ExternalConversationLink, 'mirrorPosts'>,
  itemIds: readonly string[]
): string[] {
  return itemIds.filter((itemId) => {
    const state = link.mirrorPosts?.[itemId]?.state
    return state === 'posting' || state === 'failed'
  })
}

export function withHeldTurnEnd(
  link: ExternalConversationLink,
  event: ConversationTurnEnd,
  waiting: string[]
): ExternalConversationLink {
  return { ...link, mirrorHeld: [...(link.mirrorHeld ?? []), { event, waiting }] }
}

/** The link with `itemId` no longer waited on (null: none, to collect what already waits for
 *  nothing), and the turn ends that now go; one this build can't read is dropped. */
export function releaseHeldTurnEnds(
  link: ExternalConversationLink,
  itemId: string | null
): { link: ExternalConversationLink; ready: ConversationTurnEnd[] } {
  if (!link.mirrorHeld?.length) {
    return { link, ready: [] }
  }
  const ready: ConversationTurnEnd[] = []
  const kept: SlackMirrorHeld[] = []
  for (const held of link.mirrorHeld) {
    const waiting = held.waiting.filter((waited) => waited !== itemId)
    if (waiting.length > 0) {
      kept.push({ ...held, waiting })
      continue
    }
    const event = HeldTurnEnd.safeParse(held.event)
    if (event.success) {
      ready.push(event.data)
    }
  }
  const next = { ...link }
  if (kept.length > 0) {
    next.mirrorHeld = kept
  } else {
    delete next.mirrorHeld
  }
  return { link: next, ready }
}
