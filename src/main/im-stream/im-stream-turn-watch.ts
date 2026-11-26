// The turn an IM stream opened at a known time, followed in the chat's journal: pinned to the root
// turn recorded after the stream began, and on into the turn a mid-turn message restarted it as.
// For IMs whose seam tells them a turn began, not which send opened it.
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../shared/agent-session/journal/agent-session-journal-producer'
import { followImJournal, type ImJournal, type ImJournalFollowOptions } from './im-stream-follow'
import {
  EMPTY_IM_TURN_VIEW,
  imRestartedTurnItemId,
  imTurnViewOf,
  type ImTurnView
} from './im-stream-turn-view'

// A turn's record and its turn-started event are written by different parts of the host.
const TURN_START_SLACK_MS = 5_000

export type ImTurnWatch = {
  stop(): void
  /** The journal row of the turn the watch follows, once found. */
  turnItemId(): string | null
  /** The newest rows the watch read; a read of its own when `fresh`. */
  items(fresh?: boolean): Promise<readonly AgentJournalRenderItem[]>
}

const isRootTurn = (item: AgentJournalRenderItem): boolean =>
  item.body.kind === 'turn' && isRootAgentJournalItem(item)
const isEndedRootTurn = (item: AgentJournalRenderItem): boolean =>
  isRootTurn(item) && item.body.kind === 'turn' && item.body.state !== 'running'

/** The chat's latest turns, tool output left out. */
export async function readImTurnItems(
  journal: Pick<ImJournal, 'journalReads'>,
  sessionId: string,
  latestTurns = 2
): Promise<readonly AgentJournalRenderItem[]> {
  const reads = await journal.journalReads(sessionId)
  const { snapshot } = await reads.operationWindow({ latestTurns, withoutToolOutput: true })
  return snapshot.items
}

function newest(
  items: readonly AgentJournalRenderItem[],
  take: (item: AgentJournalRenderItem) => boolean
): AgentJournalRenderItem | null {
  let found: AgentJournalRenderItem | null = null
  for (const item of items) {
    if (take(item) && (!found || item.sequence >= found.sequence)) {
      found = item
    }
  }
  return found
}

/** The root turn a stream opened at `since` follows: the newest running one recorded since then, else
 *  the newest recorded since then (it already ended); null before its record exists. */
export function imStreamTurnItemId(
  items: readonly AgentJournalRenderItem[],
  since: number
): string | null {
  const recent = items.filter((item) => isRootTurn(item) && item.observedAt >= since)
  const running = newest(
    recent,
    (item) => item.body.kind === 'turn' && item.body.state === 'running'
  )
  return (running ?? newest(recent, () => true))?.itemId ?? null
}

/** The newest root turn the journal shows over: the one whose end was just heard, when no stream
 *  pinned it. A newer turn still running is never it. */
export function imEndedTurnItemId(items: readonly AgentJournalRenderItem[]): string | null {
  return newest(items, isEndedRootTurn)?.itemId ?? null
}

/** Follows the turn recorded after `startedAt`; `onView` gets each read's view of it (empty and
 *  waiting before it is found). */
export function watchImTurn(
  journal: ImJournal,
  sessionId: string,
  startedAt: number,
  onView: (view: ImTurnView) => void,
  options: ImJournalFollowOptions = {}
): ImTurnWatch {
  // Turns already over at the first read are never the one it follows.
  let earlier: Set<string> | null = null
  let pinned: string | null = null
  let latest: readonly AgentJournalRenderItem[] = []
  const release = followImJournal(
    journal,
    sessionId,
    async (reads, active) => {
      const { snapshot } = await reads.operationWindow({ latestTurns: 2, withoutToolOutput: true })
      const { items } = snapshot
      if (!active()) {
        return
      }
      latest = items
      earlier ??= new Set(items.filter(isEndedRootTurn).map((item) => item.itemId))
      const known = earlier
      pinned ??= imStreamTurnItemId(
        items.filter((item) => !known.has(item.itemId)),
        startedAt - TURN_START_SLACK_MS
      )
      // A turn still running at the first read may be the one before, which a mid-turn message ended.
      pinned &&= imRestartedTurnItemId(items, pinned)
      onView(pinned ? imTurnViewOf(items, pinned) : EMPTY_IM_TURN_VIEW)
    },
    options
  )
  return {
    stop: release,
    turnItemId: () => pinned,
    items: async (fresh = false) =>
      fresh ? await readImTurnItems(journal, sessionId).catch(() => latest) : latest
  }
}

/** The connector message refs of root user messages that joined a running turn instead of opening
 *  one: of `turnItemId` when known, else of any turn. Each is an ask that turn answered. */
export function imJoinedMessageRefs(
  items: readonly AgentJournalRenderItem[],
  turnItemId: string | null
): Set<string> {
  const refs = new Set<string>()
  for (const item of items) {
    const { body, turnScope } = item
    if (
      body.kind === 'message' &&
      body.role === 'user' &&
      isRootAgentJournalItem(item) &&
      turnScope?.kind === 'turn' &&
      (!turnItemId || turnScope.turnItemId === turnItemId) &&
      body.asker?.messageRef
    ) {
      refs.add(body.asker.messageRef)
    }
  }
  return refs
}
