// The stop-note refresh frame carries rows, so it restates the host's current work as every rows
// frame does: a client reads a rows frame without it as an older host's and falls back to its own
// raw derivation (an ended turn as Working, an ended agent's prompt as answerable).

import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionHistoryPage,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import { isActionableStructuredAgentSessionPrompt } from '../../../shared/structured-agent-session-live-turn'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { refreshDerivedStopNotes } from './agent-session-stop-note-refresh'
import { structuredAgentSessionStopNoteIdentity } from './structured-agent-session-command-turn'
import { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import type { Subscriber } from './structured-agent-session-subscribers'

const staleTurn: AgentJournalRenderItem = {
  itemId: 'turn-old',
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: { kind: 'turn', turnId: 't-old', state: 'running', startedAt: 1 }
}
const stalePrompt: AgentJournalRenderItem = {
  itemId: 'prompt-old',
  revision: 1,
  sequence: 2,
  observedAt: 2,
  body: {
    kind: 'approval',
    title: 'Run ls',
    detail: null,
    options: [{ id: 'allow', label: 'Allow' }],
    resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  }
}
const noteId = agentJournalItemKey(structuredAgentSessionStopNoteIdentity('t-old'))
const unconfirmed = {
  kind: 'status' as const,
  text: 'x',
  failure: { kind: 'cancelUnconfirmed' as const }
}
const projectedNote: AgentJournalRenderItem = {
  itemId: noteId,
  revision: 2,
  sequence: 3,
  observedAt: 3,
  body: { kind: 'status', text: 'Stopped.' }
}
const items = [staleTurn, stalePrompt, projectedNote]

/** What a current host publishes: the ended generation's turn and prompt are not current. */
function page(): AgentSessionHistoryPage {
  return {
    sessionId: 's',
    epoch: 'e',
    direction: 'tail',
    items,
    removedItemIds: [],
    submissions: [],
    window: {
      oldest: { epoch: 'e', sequence: 1 },
      newest: { epoch: 'e', sequence: 3 },
      nextCursor: { epoch: 'e', sequence: 1 }
    },
    liveCursor: { epoch: 'e', sequence: 3 },
    hasOlder: false,
    hasNewer: false,
    latestTurn: null,
    actionablePromptIds: [],
    working: false
  }
}

describe('the stop-note refresh frame', () => {
  it("restates the host's current work, so a client keeps the host's answers", () => {
    const emitted: AgentSessionSubscribeEvent[] = []
    const journal = {
      visitItems: (visit: (itemId: string, sequence: number, body: unknown) => void) =>
        visit(noteId, 3, unconfirmed),
      snapshot: () => ({
        sessionId: 's',
        cursor: { epoch: 'e', sequence: 3 },
        items,
        submissions: []
      }),
      itemBody: (itemId: string) => (itemId === noteId ? unconfirmed : null)
    }
    // The generation live now is fence 2; both stale items came from fence 1.
    const work = new StructuredAgentSessionCurrentWork(
      {
        runningTurn: () => ({ item: staleTurn, turnId: 't-old' }),
        itemFence: () => 1,
        visitItems: (visit) => {
          for (const item of items) {
            visit(item.itemId, item.sequence, item.body)
          }
        },
        submissions: () => [],
        wroteBeforeOpen: () => false
      },
      2
    )
    const subscriber = { sessionId: 's', cursor: { epoch: 'e', sequence: 3 }, fence: 2 }
    refreshDerivedStopNotes(
      { emit: (_subscriber, event) => emitted.push(event), isActive: () => true },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the refresh reads only the subscriber's session, cursor and fence.
      subscriber as unknown as Subscriber,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the refresh reads only visitItems, snapshot and itemBody, all supplied.
      journal as unknown as AgentSessionJournal,
      10,
      work
    )

    expect(emitted).toHaveLength(1)
    const frame = emitted[0]
    if (frame?.type !== 'batch') {
      throw new Error('expected a batch')
    }
    expect(frame.batch.items.length).toBeGreaterThan(0)
    expect(frame).toMatchObject({ working: false, actionablePromptIds: [], latestTurn: null })

    let state = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event: { type: 'snapshot', sessionId: 's', page: page(), fence: 2 }
    })
    state = reduceStructuredAgentSession(state, { type: 'event', event: frame })
    expect(state.working).toBe(false)
    expect(state.latestTurn).toBeNull()
    expect(isActionableStructuredAgentSessionPrompt('prompt-old', state.actionablePromptIds)).toBe(
      false
    )
  })
})
