// What the host's own fold and history readers send a phone subscribed to a journal, at any row.

import type {
  AgentJournalCursor,
  AgentJournalSnapshot
} from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'
import {
  applyJournalRow,
  createJournalReducerState,
  renderJournalState
} from '../../../src/main/native-chat/agent-session-journal/journal-reducer'
import type { JournalRow } from '../../../src/main/native-chat/agent-session-journal/journal-row-schema'
import type { AgentSessionJournal } from '../../../src/main/native-chat/agent-session-journal/journal-store'
import {
  readAgentSessionHistory,
  readAgentSessionHydrationPage
} from '../../../src/main/native-chat/agent-session-wire/agent-session-history-page'

export type HostJournalFrames = {
  /** The host's fold after `upTo`, read through its own history readers. */
  journalAt: (upTo: number) => AgentSessionJournal
  /** The lease fence once the host has written `upTo`. */
  fenceAt: (upTo: number) => number
  /** The snapshot a phone subscribing at `upTo` gets. */
  snapshotAt: (upTo: number) => AgentSessionSubscribeEvent
  /** What the host sends a subscriber at `cursor` and `fence` once the journal reaches `upTo`: the
   *  rows since as batches carrying the subscriber's fence, or, once the fence moved (a new child),
   *  a fresh snapshot, as the attach that moved it sends every subscriber. */
  framesTo: (
    subscriber: { cursor: AgentJournalCursor; fence: number },
    upTo: number
  ) => AgentSessionSubscribeEvent[]
}

export function hostJournalFrames(
  sessionId: string,
  epoch: string,
  rows: readonly JournalRow[]
): HostJournalFrames {
  // One fold, read at every row: each row's snapshot and the aliases its readers resolve with.
  const state = createJournalReducerState(sessionId, epoch)
  const snapshots: AgentJournalSnapshot[] = []
  const aliases: ReadonlyMap<string, string>[] = []
  const fences: number[] = []
  for (const row of rows) {
    applyJournalRow(state, row)
    // A copy: the fold revises its submissions in place.
    snapshots.push(structuredClone(renderJournalState(state)))
    aliases.push(new Map(state.aliases))
    fences.push(Math.max(row.fence, fences.at(-1) ?? 0))
  }
  const journalAt = (upTo: number): AgentSessionJournal => {
    const snapshot = snapshots[upTo - 1]!
    const journal = {
      isReadOnly: false,
      snapshot: () => snapshot,
      cursor: () => snapshot.cursor,
      // Without a body the store's own resolution reads only the aliases.
      canonicalItemId: (itemId: string) => aliases[upTo - 1]!.get(itemId) ?? itemId,
      readSince: (cursor: AgentJournalCursor, limit?: number) => ({
        ok: true as const,
        rows: rows.slice(cursor.sequence, upTo).slice(0, limit),
        cursor: snapshot.cursor
      })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the history readers call only the members above.
    return journal as unknown as AgentSessionJournal
  }
  const fenceAt = (upTo: number): number => fences[upTo - 1]!
  const snapshotAt = (upTo: number): AgentSessionSubscribeEvent => {
    const fenceThen = fenceAt(upTo)
    const page = readAgentSessionHydrationPage(journalAt(upTo), fenceThen)
    return { type: 'snapshot', sessionId: sessionId, page, fence: fenceThen, hostNow: 0 }
  }
  const framesTo: HostJournalFrames['framesTo'] = (subscriber, upTo) => {
    if (fenceAt(upTo) !== subscriber.fence) {
      return [snapshotAt(upTo)]
    }
    const journal = journalAt(upTo)
    const frames: AgentSessionSubscribeEvent[] = []
    let cursor = subscriber.cursor
    for (;;) {
      const result = readAgentSessionHistory(journal, {
        sessionId: sessionId,
        direction: 'after',
        cursor,
        limit: 200
      })
      if (!result.ok) {
        throw new Error(`the host reset the stream: ${result.reset}`)
      }
      const { page } = result
      if (page.window.nextCursor.sequence <= cursor.sequence) {
        return frames
      }
      frames.push({
        type: 'batch',
        sessionId: sessionId,
        batch: {
          cursor: page.window.nextCursor,
          items: page.items,
          removedItemIds: page.removedItemIds,
          submissions: page.submissions
        },
        fence: subscriber.fence,
        hostNow: 0
      })
      cursor = page.window.nextCursor
      if (!page.hasNewer) {
        return frames
      }
    }
  }
  return { journalAt, fenceAt, snapshotAt, framesTo }
}
