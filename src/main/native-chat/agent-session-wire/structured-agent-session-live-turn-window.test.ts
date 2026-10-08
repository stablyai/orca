// A long turn's record keeps the place it opened at when revised, so a bounded page leaves it out.
// Whether a turn runs comes from the host's whole-journal record, never the loaded rows.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemIdentity,
  AgentJournalTurnLifecycle,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import {
  activeStructuredAgentSessionTurnId,
  runningStructuredAgentSessionTurnId
} from '../../../shared/structured-agent-session-live-turn'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../shared/structured-agent-session-reducer'
import { selectStructuredAgentTurnBars } from '../../../shared/structured-agent-session-turn-timing'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  readAgentSessionHistory,
  readAgentSessionHydrationPage
} from './agent-session-history-page'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}

const journals = createTrackedJournalOpener()
let root: string
let journal: AgentSessionJournal

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-live-turn-window-'))
  journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function turnRecord(turnId: string, ordinal = 0): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId, ordinal }
}

async function writeTurn(turnId: string, turn: Omit<AgentJournalTurnLifecycle, 'turnId'>) {
  await journal.appendItem(
    turnRecord(turnId),
    { kind: 'turn', turnId, ...turn },
    { fence: 1, turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(turnRecord(turnId)) } }
  )
}

/** A running turn whose record sits `rows` rows above the journal head. */
async function runLongTurn(turnId: string, rows: number): Promise<void> {
  await writeTurn(turnId, { state: 'running', startedAt: 1_000, requestedAt: 900 })
  const turnScope = { kind: 'turn' as const, turnItemId: agentJournalItemKey(turnRecord(turnId)) }
  for (let ordinal = 1; ordinal <= rows; ordinal += 1) {
    await journal.appendItem(
      turnRecord(turnId, ordinal),
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `row ${ordinal}` }] },
      { fence: 1, turnScope }
    )
  }
}

function hydrate(): StructuredAgentSessionState {
  const page = readAgentSessionHydrationPage(journal, 1)
  return reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
    type: 'event',
    event: { type: 'snapshot', sessionId: 'session-1', page, fence: 1 }
  })
}

/** A live subscriber attached at `state`'s cursor; returns a pump that applies what it was sent. */
function subscribeFrom(state: StructuredAgentSessionState) {
  const events: AgentSessionSubscribeEvent[] = []
  const subscribers = new AgentSessionSubscribers()
  subscribers.open({
    id: 'client-1',
    sessionId: 'session-1',
    journal,
    fence: 1,
    emit: (event) => events.push(event),
    ...(state.cursor ? { cursor: state.cursor } : {})
  })
  let current = state
  return {
    subscribers,
    events,
    apply(): StructuredAgentSessionState {
      for (const event of events.splice(0)) {
        current = reduceStructuredAgentSession(current, { type: 'event', event })
      }
      return current
    }
  }
}

describe('a running turn whose record is older than the loaded page', () => {
  it('is running in the chat, as it is on the host', async () => {
    await runLongTurn('turn-1', 250)
    const state = hydrate()

    expect(journal.activeTurnId()).toBe('turn-1')
    expect(state.hasOlder).toBe(true)
    // What every client read before: the record is off the page, so the loaded rows said idle.
    expect(activeStructuredAgentSessionTurnId(state.items)).toBeNull()
    expect(runningStructuredAgentSessionTurnId(state)).toBe('turn-1')
  })

  it('counts Working from the host record when the record is not loaded', async () => {
    await runLongTurn('turn-1', 250)
    const state = hydrate()
    const turnId = runningStructuredAgentSessionTurnId(state)

    const { runningTiming } = selectStructuredAgentTurnBars(
      state.items,
      state.submissions,
      turnId,
      state.latestTurn
    )
    expect(runningTiming).toMatchObject({ state: 'running', startedAt: 1_000, requestedAt: 900 })
  })

  it('stops reading as running when the turn ends off the page', async () => {
    await runLongTurn('turn-1', 250)
    const live = subscribeFrom(hydrate())

    await writeTurn('turn-1', { state: 'completed', startedAt: 1_000, completedAt: 2_000 })
    live.subscribers.publish('session-1', journal)
    const state = live.apply()

    // The completing revision keeps its old position, so the window never admits it.
    expect(
      state.items.some((item) => item.itemId === agentJournalItemKey(turnRecord('turn-1')))
    ).toBe(false)
    expect(runningStructuredAgentSessionTurnId(state)).toBeNull()
    expect(state.latestTurn?.turn).toMatchObject({ turnId: 'turn-1', state: 'completed' })
  })

  it('follows the next turn as it opens', async () => {
    await runLongTurn('turn-1', 250)
    await writeTurn('turn-1', { state: 'completed', startedAt: 1_000, completedAt: 2_000 })
    const live = subscribeFrom(hydrate())

    await writeTurn('turn-2', { state: 'running', startedAt: 3_000 })
    live.subscribers.publish('session-1', journal)

    expect(runningStructuredAgentSessionTurnId(live.apply())).toBe('turn-2')
  })

  it('is not undone by an older page read while live frames moved on', async () => {
    await runLongTurn('turn-1', 250)
    const before = hydrate()
    const older = readAgentSessionHistory(journal, {
      sessionId: 'session-1',
      direction: 'before',
      cursor: { epoch: before.epoch ?? '', sequence: before.items[0]?.sequence ?? 0 },
      limit: 40
    })
    const live = subscribeFrom(before)
    await writeTurn('turn-1', { state: 'completed', startedAt: 1_000, completedAt: 2_000 })
    live.subscribers.publish('session-1', journal)
    const ended = live.apply()

    if (!older.ok) {
      throw new Error(`expected an older page, got reset ${older.reset}`)
    }
    // The older page was read while the turn still ran.
    expect(older.page.latestTurn?.turn.state).toBe('running')
    const after = reduceStructuredAgentSession(ended, {
      type: 'older-page',
      requestedCursor: { epoch: ended.epoch ?? '', sequence: ended.items[0]?.sequence ?? 0 },
      page: older.page
    })
    expect(runningStructuredAgentSessionTurnId(after)).toBeNull()
  })
})

describe('an older host, which publishes no latest turn', () => {
  it('still reads the turn off the loaded rows', async () => {
    await writeTurn('turn-1', { state: 'running', startedAt: 1_000 })
    const { latestTurn: _omitted, ...page } = readAgentSessionHydrationPage(journal, 1)
    const state = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event: { type: 'snapshot', sessionId: 'session-1', page, fence: 1 }
    })

    expect(state.latestTurn).toBeUndefined()
    expect(runningStructuredAgentSessionTurnId(state)).toBe('turn-1')
  })

  it('reads a journal with no turn as idle, not unknown', async () => {
    const state = hydrate()

    expect(state.latestTurn).toBeNull()
    expect(runningStructuredAgentSessionTurnId(state)).toBeNull()
  })
})
