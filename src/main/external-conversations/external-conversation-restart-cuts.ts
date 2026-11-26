// A linked chat the run that just ended cut mid-turn, and that this start did not continue, never
// ends that turn: its conversation would wait on it forever. Each such turn its conversation heard
// ends once, as interrupted, so the conversation offers Resume.

import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionRestartCut } from '../native-chat/agent-session-wire/recovery/structured-agent-session-restart-resume-contract'
import type { ConversationEvent } from './external-conversation-events'
import {
  findLinksForSession,
  type ExternalConversationLinkStore,
  type LinkedConversation
} from './external-conversation-links'
import type { ExternalConversationSeam } from './external-conversation-seam'
import { turnOpenerOf } from './external-conversation-ended-turn'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { isConversationReport } from './external-conversation-turn-opener'
import { conversationPane } from './external-conversation-types'

type TurnEnded = Extract<ConversationEvent, { kind: 'turn-ended' }>

export type RestartCutTurnEndsDeps = {
  /** The launch continuation's chats the last run cut that this start did not continue. */
  cutByLastRun: ReadonlySet<string>
  linksFor: (sessionId: string) => readonly LinkedConversation[]
  /** Opens the chat so its cut is read from its journal. */
  open: (sessionId: string) => Promise<unknown>
  offeredCuts: () => Promise<ReadonlyMap<string, StructuredAgentSessionRestartCut>>
  cutOf: (
    sessionId: string,
    offered: ReadonlyMap<string, StructuredAgentSessionRestartCut>
  ) => Promise<StructuredAgentSessionRestartCut | null>
  /** The message that opened the cut turn; undefined when it can't be read. */
  openerOf: (
    sessionId: string,
    turnId: string
  ) => Promise<AgentJournalRenderItem | null | undefined>
  /** When this process started: every turn the last run told is older, every turn of this run newer. */
  startedAt: number
  now: () => number
}

/** Whether the conversation was told of the turn this message opened: its own delivery, a
 *  continuation of its requests, mail finishing its ask (as ChatTurns hears them), or the owner's
 *  message the Slack mirror posted there. */
export function conversationHeardTurn(
  { link }: LinkedConversation,
  opener: AgentJournalRenderItem | null | undefined
): boolean {
  const body = opener?.body
  if (!opener || body?.kind !== 'message') {
    return false
  }
  if (link.mirrorPosts?.[opener.itemId]?.state === 'posted') {
    return true
  }
  const names = (conversation: { source: string; externalId: string } | undefined) =>
    conversation?.source === link.source && conversation.externalId === link.externalId
  return (
    names(body.connectorConversation) ||
    names(body.connectorDelivery?.conversation) ||
    Boolean(body.connectorClaim?.origin.some((stamp) => names(stamp.conversation))) ||
    // A plain linked chat answers one conversation, so any connector message is its delivery.
    (!link.bot && body.origin === 'connector') ||
    (link.bot?.kind !== 'bot-chat' && isConversationReport(body))
  )
}

export async function restartCutTurnEnds(deps: RestartCutTurnEndsDeps): Promise<TurnEnded[]> {
  const linked = [...deps.cutByLastRun].flatMap((sessionId) =>
    deps.linksFor(sessionId).length > 0 ? [sessionId] : []
  )
  if (linked.length === 0) {
    return []
  }
  const offered = await deps.offeredCuts()
  const ends: TurnEnded[] = []
  for (const sessionId of linked) {
    await deps.open(sessionId)
    const cut = await deps.cutOf(sessionId, offered)
    // An agent that may still be running may still end its own turn; a lead that finished already
    // told its conversation how it went, though its background work was cut.
    if (!cut || cut.exitUnproven || cut.continuationUnconfirmed || cut.leadDone) {
      continue
    }
    const opener = await deps.openerOf(sessionId, cut.turnId)
    for (const conversation of deps.linksFor(sessionId)) {
      if (!conversationHeardTurn(conversation, opener)) {
        continue
      }
      ends.push({
        kind: 'turn-ended',
        ...conversationPane(conversation.link, conversation.workspace.worktreeId),
        // A fence, not the turn's own start (lost with the last run): the cloud ends its open turn
        // when that turn is no newer, so this ends what the last run told, never one this start began.
        turnId: deps.startedAt,
        stopReason: 'interruption',
        // No words: Slack and GitHub edit the status only, Linear ends its session with the error.
        at: deps.now()
      })
    }
  }
  return ends
}

/** Turn ends told now, or held until the next watch while none watches. */
export function heldTurnEnds(seam: () => Pick<ExternalConversationSeam, 'tellTurnEnd'> | null) {
  const held: TurnEnded[] = []
  return {
    tell: (event: TurnEnded) => {
      if (!seam()?.tellTurnEnd(event)) {
        held.push(event)
      }
    },
    flush: () => held.splice(0).forEach((event) => seam()?.tellTurnEnd(event))
  }
}

/** Once the launch continuation settled, the linked chats it left cut end their open turn. */
export function endRestartCutTurns(
  store: ExternalConversationLinkStore,
  launch: { continued: Promise<{ cutByLastRun: ReadonlySet<string> }> } | undefined,
  signal: AbortSignal,
  tell: (event: TurnEnded) => void
): void {
  void launch?.continued
    .then(async ({ cutByLastRun }) => {
      const host = getStructuredAgentSessionHost()
      if (!host || signal.aborted) {
        return
      }
      const ends = await restartCutTurnEnds({
        cutByLastRun,
        linksFor: (sessionId) => findLinksForSession(store, sessionId),
        open: (sessionId) => host.revealSession(sessionId).catch(() => null),
        offeredCuts: () => host.restartResume.offeredCuts(),
        cutOf: (sessionId, offered) => host.restartResume.cutOf(sessionId, offered),
        openerOf: (sessionId, turnId) => turnOpenerOf(host, sessionId, turnId),
        startedAt: Math.trunc(performance.timeOrigin),
        now: Date.now
      })
      if (!signal.aborted) {
        ends.forEach(tell)
      }
    })
    .catch((error: unknown) => {
      console.warn('[connector] ending turns a restart cut failed', error)
    })
}
