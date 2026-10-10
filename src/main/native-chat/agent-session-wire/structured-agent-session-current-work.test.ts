// The host's one projection of current work (`structuredAgentSessionCurrentWork`), end to end
// against the real host, store and SQLite journal: what an ended generation left holds nothing and
// reads as nothing to every reader (the projection, the session list, a chat client, Stop, a prompt
// answer, the queue), whether or not its cleanup or its release landed, while a live owner's work
// holds exactly as before.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import {
  isActionableStructuredAgentSessionPrompt,
  runningStructuredAgentSessionTurnId
} from '../../../shared/structured-agent-session-live-turn'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../shared/structured-agent-session-reducer'
import {
  liveTestJournalRows,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  APPROVAL,
  currentJournal,
  currentWork,
  exitWhileSettlementFails,
  leaveUnfinishedWork,
  REJECT_RECOVERED_ROWS,
  sendText,
  turnState
} from './structured-agent-session-leftover-settlement.test-fixture'
import { retryIdle } from './structured-agent-session-retry.test-fixture'

let rig: QueuedMessageTestRig | undefined

afterEach(async () => {
  await rig?.dispose()
  rig = undefined
  vi.restoreAllMocks()
})

const APPROVAL_ID = agentJournalItemKey(APPROVAL)
const FOLDER: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'folder-1',
  workspaceKind: 'folder'
}

/** A chat client and the session list, each fed by the host as a real one is. */
function watch(current: QueuedMessageTestRig) {
  let chat: StructuredAgentSessionState = EMPTY_STRUCTURED_AGENT_SESSION
  let listed: AgentSessionStatusSummary | undefined
  current.host.subscribe({
    id: 'chat-1',
    sessionId: SESSION,
    emit: (event) => {
      chat = reduceStructuredAgentSession(chat, { type: 'event', event: structuredClone(event) })
    }
  })
  current.host.subscribeStatus({
    id: 'list-1',
    emit: (event) => {
      if (event.type === 'status' && event.session.sessionId === SESSION) {
        listed = structuredClone(event.session)
      } else if (event.type === 'snapshot') {
        listed = event.sessions.find((session) => session.sessionId === SESSION) ?? listed
      }
    }
  })
  return {
    chat: () => chat,
    listed: () => listed,
    /** Whether the chat would let the person answer the prompt. */
    answerable: () =>
      chat.items.some(
        (item) =>
          item.itemId === APPROVAL_ID &&
          item.body.kind === 'approval' &&
          item.body.resolution.state === 'pending' &&
          isActionableStructuredAgentSessionPrompt(item.itemId, chat.actionablePromptIds)
      )
  }
}

/** The tail page a client hydrates from. */
async function hydration(current: QueuedMessageTestRig) {
  const page = await current.host.history({ sessionId: SESSION, direction: 'tail' })
  if (!page.ok) {
    throw new Error('history refused')
  }
  return page.page
}

async function deadGenerationWithFailedSettlement(location?: typeof FOLDER) {
  rig = await createQueuedMessageTestRig({
    restartable: true,
    ...(location ? { location } : {})
  })
  const current = rig
  await current.workingSend()
  await leaveUnfinishedWork(current, { prompt: true })
  const view = watch(current)
  const exited = await exitWhileSettlementFails(current)
  return { current, view, ...exited }
}

describe("a dead generation's leftovers, its settlement refused and its lease released", () => {
  it.each([
    ['a git worktree', undefined],
    ['a folder workspace', FOLDER]
  ])('in %s, read as nothing by every reader, and hold nothing', async (_name, location) => {
    const { current, view } = await deadGenerationWithFailedSettlement(location)
    // Still saved as running and pending: only a settlement would end them.
    expect(turnState(current)).toBe('running')
    const work = currentWork(current)

    expect(work.liveFence).toBeNull()
    expect(work.working()).toBe(false)
    expect(work.actionablePromptIds()).toEqual([])
    expect(view.listed()?.status).not.toBe('working')
    expect(current.host.readStatusSummary(SESSION)?.status).not.toBe('working')
    // A client hydrating now, and the one already watching, read the same.
    const page = await hydration(current)
    expect(page.latestTurn).toBeNull()
    expect(page.actionablePromptIds).toEqual([])
    await vi.waitFor(() => expect(view.chat().actionablePromptIds).toEqual([]))
    expect(runningStructuredAgentSessionTurnId(view.chat())).toBeNull()
    expect(view.answerable()).toBe(false)
  })

  it('gives Stop nothing to stop: the dead turn is not touched', async () => {
    const { current } = await deadGenerationWithFailedSettlement()

    await current.stop()

    expect(current.cancelTurn).not.toHaveBeenCalled()
    expect(turnState(current)).toBe('running')
  })
})

describe('a close Orca asked for, its settlement refused', () => {
  it('tells a watching client the turn and prompt are over, with no row to carry it', async () => {
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    await current.workingSend()
    await leaveUnfinishedWork(current, { prompt: true })
    const view = watch(current)
    await vi.waitFor(() => expect(view.answerable()).toBe(true))
    const database = openTestJournalHostDatabase(current.root)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    database.db.exec(REJECT_RECOVERED_ROWS)
    const before = currentJournal(current).cursor().sequence
    const child = current.host.collaboratorsForTests().sessions.get(SESSION)?.child
    if (!child?.generation) {
      throw new Error('expected the live child')
    }

    await current.host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      cause: 'requested-close',
      reason: 'closed by Orca',
      fence: child.fence,
      acquisitionGeneration: child.generation
    })
    await current.host.collaboratorsForTests().serialize(SESSION, async () => {})

    expect(currentJournal(current).cursor().sequence).toBe(before)
    expect(turnState(current)).toBe('running')
    await vi.waitFor(() => expect(view.answerable()).toBe(false))
    expect(runningStructuredAgentSessionTurnId(view.chat())).toBeNull()
    expect(view.listed()?.status).not.toBe('working')
  })
})

describe('a waiting card when the generation ahead of it ends', () => {
  it.each([
    ['an exit of its own, its settlement refused', 'unexpected-exit' as const],
    ['a close Orca asked for', 'requested-close' as const]
  ])('drains after %s, with no journal write in between', async (_name, cause) => {
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    await current.workingSend()
    await leaveUnfinishedWork(current)
    const queued = await sendText(current, 'behind the turn').result
    expect(queued).toMatchObject({ ok: true, value: { queued: expect.anything() } })
    const journal = currentJournal(current)
    const [card] = journal.queuedMessages.list()
    expect(card?.state).toBe('waiting')
    const database = openTestJournalHostDatabase(current.root)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    database.db.exec(REJECT_RECOVERED_ROWS)
    const before = journal.cursor().sequence
    const child = current.host.collaboratorsForTests().sessions.get(SESSION)?.child
    if (!child?.generation) {
      throw new Error('expected the live child')
    }

    await current.host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      cause,
      reason: 'ended',
      fence: child.fence,
      acquisitionGeneration: child.generation
    })

    await vi.waitFor(() =>
      expect(journal.queuedMessages.get(card?.messageId ?? '')?.state).toBe('dispatched')
    )
    // The first row after the end is the drain's own hand-off: nothing was written to wake it.
    const first = liveTestJournalRows(database.db, SESSION).find((row) => row.seq > before)
    expect(JSON.parse(first?.rowJson ?? '{}')).toMatchObject({
      kind: 'submission',
      queuedMessageId: card?.messageId
    })
    await vi.waitFor(() => expect(current.dispatch).toHaveBeenCalledTimes(2))
  })
})

describe('an observed exit whose release write failed', () => {
  it('reads as not Working, and a send is delivered', async () => {
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    await current.workingSend()
    await leaveUnfinishedWork(current, { prompt: true })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const transition = current.store.transitionHandoff.bind(current.store)
    let refused = 0
    vi.spyOn(current.store, 'transitionHandoff').mockImplementation((sessionId, change) =>
      transition(sessionId, (record) => {
        const next = change(record)
        // The exit's own release, and the retry's first repair of it.
        if (refused < 2 && next.lease.claimStatus === 'released') {
          refused += 1
          throw new Error('disk full')
        }
        return next
      })
    )
    const child = current.host.collaboratorsForTests().sessions.get(SESSION)?.child
    if (!child?.generation) {
      throw new Error('expected the live child')
    }

    await current.host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      cause: 'unexpected-exit',
      reason: 'observed exit',
      fence: child.fence,
      acquisitionGeneration: child.generation
    })
    await current.host.collaboratorsForTests().serialize(SESSION, async () => {})
    await retryIdle(current.host.collaboratorsForTests().reconciliation, SESSION)

    expect(refused).toBe(2)
    // The release never landed: the lease still names the gone child.
    expect(current.store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'live',
      runtimeFence: child.fence
    })
    const work = currentWork(current)
    expect(work.liveFence).toBeNull()
    expect(work.working()).toBe(false)
    expect(work.actionablePromptIds()).toEqual([])
    expect(current.host.readStatusSummary(SESSION)?.status).not.toBe('working')

    expect((await sendText(current, 'go on').result).ok).toBe(true)
    await vi.waitFor(() => expect(current.dispatch).toHaveBeenCalledTimes(2))
  })
})

describe('a live owner', () => {
  it('publishes its running turn and its prompt exactly as before', async () => {
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    await current.workingSend()
    await leaveUnfinishedWork(current, { prompt: true })
    const view = watch(current)

    const work = currentWork(current)
    expect(work.liveFence).toBe(current.store.getRecord(SESSION)?.lease.runtimeFence)
    expect(work.activeTurnId()).toBe('unfinished')
    expect(work.actionablePromptIds()).toEqual([APPROVAL_ID])
    const page = await hydration(current)
    expect(page.latestTurn?.turn).toMatchObject({ turnId: 'unfinished', state: 'running' })
    expect(page.actionablePromptIds).toEqual([APPROVAL_ID])
    await vi.waitFor(() => expect(view.chat().actionablePromptIds).toEqual([APPROVAL_ID]))
    expect(runningStructuredAgentSessionTurnId(view.chat())).toBe('unfinished')
    expect(view.answerable()).toBe(true)
    expect(view.listed()?.status).not.toBe('idle')
  })
})
