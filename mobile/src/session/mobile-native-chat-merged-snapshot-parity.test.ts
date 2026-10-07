// The phone's list built from the frames it merged must equal the list a fresh snapshot of the same
// journal builds, and must show the stop row from the frame that took the send back. Covers journal
// -> host readers -> phone reducer -> projection -> fold -> turn membership, bars and the list's
// disclosure; the phone's own hooks, its echo and the host's Stopping are covered by
// mobile-native-chat-merged-snapshot-parity-hooks.test.tsx. Not covered:
// - a batch that carries a new fence (the background-task publish, rows an attach drains);
// - what the exit's settlement writes after the withdrawal (unknown marks, a lifecycle batch);
// - a queue-capable phone's send while stopping as a queued draft card and its hand-off.

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'
import { withNativeChatCutTurnNotices } from '../../../src/shared/native-chat-cut-turn-notice'
import { nativeChatRowsInDrawOrder } from '../../../src/shared/native-chat-turn-grouping'
import { nativeChatTurnMembership } from '../../../src/shared/native-chat-turn-membership'
import { nativeChatMessagesWaitingBehindLiveTurn } from '../../../src/shared/native-chat-messages-waiting-behind-live-turn'
import { activeStructuredAgentSessionTurnId } from '../../../src/shared/structured-agent-session-live-turn'
import { isStructuredAgentSessionMainAgentWorking } from '../../../src/shared/structured-agent-session-main-agent-working'
import { projectStructuredAgentSessionMessages } from '../../../src/shared/structured-agent-session-message-projection'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../src/shared/structured-agent-session-reducer'
import { selectStructuredAgentTurnBars } from '../../../src/shared/structured-agent-session-turn-timing'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../src/shared/tui-agent-display-names'
import {
  buildMobileNativeChatTransientData,
  foldMobileNativeChatMessages
} from './mobile-native-chat-render-data'
import {
  NEVER_OPENED,
  stopJournal,
  type StopJournal
} from './mobile-native-chat-stop-journal.test-fixture'
import { useMobileNativeChatTurnDisclosure } from './use-mobile-native-chat-turn-disclosure'

const STOP_ROW = `stopped-before-start:orca:${NEVER_OPENED}`

type Drawn = { header: string; rows: { id: string; role: string; line: string }[] }

function apply(
  state: StructuredAgentSessionState,
  events: readonly AgentSessionSubscribeEvent[]
): StructuredAgentSessionState {
  // Each phone gets its own copy, as it would off the wire.
  return events.reduce(
    (next, event) =>
      reduceStructuredAgentSession(next, { type: 'event', event: structuredClone(event) }, 0),
    state
  )
}

/** The rows the phone's transcript reads, as its session hook builds them: the journal plus the
 *  notice a cut turn gets, projected with no other rejected send drawn in place. */
function phoneTranscript(state: StructuredAgentSessionState) {
  const items = withNativeChatCutTurnNotices(state.items, {
    agentName: TUI_AGENT_DISPLAY_NAMES.codex
  })
  return {
    items,
    messages: projectStructuredAgentSessionMessages(items, [], state.submissions, {
      rejectedInPlace: false
    })
  }
}

/** What the phone's list draws: each row in draw order, its content, its turn and that turn's bar. */
function drawn(state: StructuredAgentSessionState): Drawn {
  const { items, messages } = phoneTranscript(state)
  const folded = foldMobileNativeChatMessages(messages)
  const { data } = buildMobileNativeChatTransientData({
    messages,
    folded,
    streaming: null,
    pending: []
  })
  const membership = nativeChatTurnMembership(data, { items, submissions: state.submissions })
  const rows = nativeChatRowsInDrawOrder(data, membership.drawOrder)
  const turnKeys = nativeChatRowsInDrawOrder(membership.turnKeys, membership.drawOrder)
  const waiting = nativeChatMessagesWaitingBehindLiveTurn(rows, items)
  const turnId = activeStructuredAgentSessionTurnId(state.items)
  const { settledTurns } = selectStructuredAgentTurnBars(items, state.submissions, turnId)
  const working = isStructuredAgentSessionMainAgentWorking(turnId, state.submissions, state.fence)
  return {
    header: `working ${working} live ${membership.liveTurnKey ?? '-'}`,
    rows: rows.map((row, index) => {
      const turnKey = turnKeys[index]
      const bar = turnKey === undefined ? '-' : JSON.stringify(settledTurns.get(turnKey) ?? 'none')
      const flags = [row.stoppedBeforeStart ? 'stopped' : '', waiting.has(row.id) ? 'waiting' : '']
      const line = [row.id, row.role, ...flags, turnKey ?? '-', bar, JSON.stringify(row.blocks)]
      return { id: row.id, role: row.role, line: line.join(' ') }
    })
  }
}

/** The ids the phone's list shows: its rows through the list's own turn disclosure. */
function listed(state: StructuredAgentSessionState): string[] {
  const { items, messages } = phoneTranscript(state)
  const folded = foldMobileNativeChatMessages(messages)
  const { data } = buildMobileNativeChatTransientData({
    messages,
    folded,
    streaming: null,
    pending: []
  })
  const turnId = activeStructuredAgentSessionTurnId(state.items)
  const { settledTurns } = selectStructuredAgentTurnBars(items, state.submissions, turnId)
  let ids: string[] = []
  function List(): null {
    const turns = useMobileNativeChatTurnDisclosure({
      messages: data,
      enabled: true,
      isWorking: isStructuredAgentSessionMainAgentWorking(turnId, state.submissions, state.fence),
      settledTurns,
      turnJournal: { items, submissions: state.submissions },
      scopeKey: 'host\0workspace\0tab'
    })
    ids = turns.listMessages.map((row) => row.id)
    return null
  }
  let renderer: ReactTestRenderer | null = null
  act(() => {
    renderer = create(createElement(List))
  })
  act(() => renderer!.unmount())
  return ids
}

/**
 * A fresh page starts part way into a long chat, and a turn whose user row it cut off is keyed
 * differently there; so both lists are compared from the fresh page's first user row on.
 */
function comparable(merged: Drawn, fresh: Drawn): { merged: string[]; fresh: string[] } {
  const first = fresh.rows.findIndex((row) => row.role === 'user')
  const from = first === -1 ? fresh.rows.length : first
  const anchor = fresh.rows[from]?.id
  const mergedFrom =
    anchor === undefined ? merged.rows.length : merged.rows.findIndex((row) => row.id === anchor)
  return {
    merged: [
      merged.header,
      ...merged.rows.slice(mergedFrom === -1 ? 0 : mergedFrom).map((row) => row.line)
    ],
    fresh: [fresh.header, ...fresh.rows.slice(from).map((row) => row.line)]
  }
}

/** Every frame from each subscribe point in `starts`, `rowsPerFrame` rows at a time; with how many
 *  of those frames the merged state held only a window of the chat. */
function compareFrames(
  journal: StopJournal,
  starts: readonly number[],
  rowsPerFrame: number
): { differing: string[]; windowed: number } {
  const last = journal.rows.length
  const fresh = new Map<number, Drawn>()
  const freshAt = (upTo: number): Drawn => {
    const cached = fresh.get(upTo)
    if (cached) {
      return cached
    }
    const drawnThen = drawn(apply(EMPTY_STRUCTURED_AGENT_SESSION, [journal.snapshotAt(upTo)]))
    fresh.set(upTo, drawnThen)
    return drawnThen
  }
  const freshListing = new Map<number, boolean>()
  const freshListed = (upTo: number): boolean => {
    const cached = freshListing.get(upTo)
    if (cached !== undefined) {
      return cached
    }
    const shown = listed(
      apply(EMPTY_STRUCTURED_AGENT_SESSION, [journal.snapshotAt(upTo)])
    ).includes(STOP_ROW)
    freshListing.set(upTo, shown)
    return shown
  }
  const differing: string[] = []
  let windowed = 0
  for (const start of starts) {
    let merged = apply(EMPTY_STRUCTURED_AGENT_SESSION, [journal.snapshotAt(start)])
    for (let upTo = Math.min(start + rowsPerFrame, last); upTo <= last;) {
      merged = apply(
        merged,
        journal.framesTo({ cursor: merged.cursor!, fence: merged.fence! }, upTo)
      )
      windowed += merged.hasOlder ? 1 : 0
      const compared = comparable(drawn(merged), freshAt(upTo))
      if (JSON.stringify(compared.merged) !== JSON.stringify(compared.fresh)) {
        differing.push(`subscribed at ${start}, frame through ${upTo}`)
      }
      if (upTo >= journal.takenBack && !listed(merged).includes(STOP_ROW)) {
        differing.push(`subscribed at ${start}, no stop row in the list through ${upTo}`)
      }
      if (upTo >= journal.takenBack && !freshListed(upTo)) {
        differing.push(`fresh at ${upTo}, no stop row in the list`)
      }
      upTo = upTo === last ? last + 1 : Math.min(upTo + rowsPerFrame, last)
    }
  }
  return { differing, windowed }
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from }, (_, index) => from + index)

// The QA journal has the host write a send made while stopping after the stopped turn's end; a host
// that writes it while the turn still runs is covered too.
describe.each(['after-end', 'during-turn'] as const)(
  'a short chat, the send while stopping written %s: merged frames draw as a fresh snapshot does',
  (sendWhileStopping) => {
    const journal = stopJournal(8, sendWhileStopping)

    it('draws the send the exit took back with its stop row, from the frame that took it back', () => {
      const fresh = drawn(
        apply(EMPTY_STRUCTURED_AGENT_SESSION, [journal.snapshotAt(journal.takenBack)])
      )
      expect(fresh.rows.slice(-2).map((row) => row.line.split(' ').slice(0, 3).join(' '))).toEqual([
        `orca:${NEVER_OPENED} user stopped`,
        `stopped-before-start:orca:${NEVER_OPENED} system `
      ])
    })

    it.each([1, 2, 3])('from every subscribe point, %i row(s) per frame', (rowsPerFrame) => {
      expect(compareFrames(journal, range(2, journal.rows.length), rowsPerFrame).differing).toEqual(
        []
      )
    })
  }
)

describe('a chat longer than the phone first loads', () => {
  const journal = stopJournal(70)
  const last = journal.rows.length
  // Every 37th row of the history, then every row from the last two history turns on, which revise
  // and drop a status the window then holds.
  const lastTurns = journal.neverOpenedSent - 70
  const starts = [...range(2, lastTurns).filter((row) => row % 37 === 0), ...range(lastTurns, last)]

  it('draws the same at every frame from each subscribe point, from a window of the chat', () => {
    expect(apply(EMPTY_STRUCTURED_AGENT_SESSION, [journal.snapshotAt(last)]).hasOlder).toBe(true)
    const { differing, windowed } = compareFrames(journal, starts, 1)
    expect(differing).toEqual([])
    expect(windowed).toBeGreaterThan(1_000)
  }, 60_000)
})
