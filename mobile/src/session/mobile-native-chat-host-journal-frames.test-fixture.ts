import type { AgentJournalCursor } from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'
import {
  applyJournalRow,
  createJournalReducerState
} from '../../../src/main/native-chat/agent-session-journal/journal-reducer'
import { readJournalPublicView } from '../../../src/main/native-chat/agent-session-journal/journal-public-read'
import type { JournalRow } from '../../../src/main/native-chat/agent-session-journal/journal-row-schema'
import type { AgentSessionJournal } from '../../../src/main/native-chat/agent-session-journal/journal-store'
import {
  readAgentSessionHistory,
  readAgentSessionHydrationPage
} from '../../../src/main/native-chat/agent-session-wire/agent-session-history-page'

export type HostJournalFrames = {
  journalAt: (upTo: number) => AgentSessionJournal
  fenceAt: (upTo: number) => number
  snapshotAt: (upTo: number) => AgentSessionSubscribeEvent
  // Fence changes publish fresh snapshots; otherwise send cursor batches under the subscriber’s fence.
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
  const state = createJournalReducerState(sessionId, epoch)
  const views: ReturnType<typeof readJournalPublicView>[] = []
  const aliases: ReadonlyMap<string, string>[] = []
  const fences: number[] = []
  for (const row of rows) {
    applyJournalRow(state, row)
    // Clone each view because the fold revises submissions in place.
    views.push(structuredClone(readJournalPublicView(state)))
    aliases.push(new Map(state.aliases))
    fences.push(Math.max(row.fence, fences.at(-1) ?? 0))
  }
  const journalAt = (upTo: number): AgentSessionJournal => {
    const view = views[upTo - 1]!
    const { snapshot } = view
    const journal = {
      isReadOnly: false,
      snapshot: () => snapshot,
      publicRead: () => view,
      cursor: () => snapshot.cursor,
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
