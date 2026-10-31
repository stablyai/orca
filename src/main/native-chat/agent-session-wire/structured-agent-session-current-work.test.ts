// Ended generations must hold no work across projection, status, chat, Stop, prompts and queue,
// even when settlement/release writes fail; live generations retain their work.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import type { AgentSessionStatusSnapshot } from '../../../shared/agent-session-status-snapshot-fold'
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

// Mobile has its own typecheck project; run its real consumer across the shared wire boundary.
const phoneFeedPath = '../../../../mobile/src/session/mobile-structured-session-status-feed'
const phoneClientPath = '../../../../mobile/src/transport/rpc-client-test-stub'
const { mobileStructuredSessionStatusFeed } = await import(phoneFeedPath)
const { stubRpcClient } = await import(phoneClientPath)

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

function watch(current: QueuedMessageTestRig) {
  let chat: StructuredAgentSessionState = EMPTY_STRUCTURED_AGENT_SESSION
  let listed: AgentSessionStatusSummary | undefined
  const phone: {
    subscribe: (listener: () => void) => () => void
    getSnapshot: () => AgentSessionStatusSnapshot
  } = mobileStructuredSessionStatusFeed(
    stubRpcClient({
      subscribe: (
        _method: string,
        _params: unknown,
        emit: (event: AgentSessionStatusEvent) => void
      ) =>
        current.host.subscribeStatus({
          id: 'phone-1',
          emit: (event) => emit(structuredClone(event))
        })
    })
  )
  phone.subscribe(() => {})
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
    phone: () => phone.getSnapshot().get(SESSION),
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
    // Persisted rows still claim running/pending; projection must apply exit evidence.
    expect(turnState(current)).toBe('running')
    const work = currentWork(current)

    expect(work.liveFence).toBeNull()
    expect(work.working()).toBe(false)
    expect(work.actionablePromptIds()).toEqual([])
    expect(view.listed()?.status).not.toBe('working')
    expect(view.phone()?.status).toBe(view.listed()?.status)
    expect(current.host.readStatusSummary(SESSION)?.status).not.toBe('working')
    const page = await hydration(current)
    expect(page.latestTurn?.turn.state).toBe('interrupted')
    expect(page.actionablePromptIds).toEqual([])
    expect(page.working).toBe(false)
    await vi.waitFor(() => expect(view.chat().actionablePromptIds).toEqual([]))
    expect(view.chat().working).toBe(false)
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
      deathEvidenceKind: 'kill-delivered',
      fence: child.fence,
      acquisitionGeneration: child.generation
    })
    await current.host.collaboratorsForTests().serialize(SESSION, async () => {})

    expect(current.store.getRecord(SESSION)?.lease.deathEvidence?.kind).toBe('kill-delivered')
    expect(currentJournal(current).cursor().sequence).toBe(before)
    expect(turnState(current)).toBe('running')
    await vi.waitFor(() => expect(view.answerable()).toBe(false))
    expect(view.chat().working).toBe(false)
    expect(runningStructuredAgentSessionTurnId(view.chat())).toBeNull()
    expect(view.listed()?.status).not.toBe('working')
    expect(view.phone()?.status).toBe(view.listed()?.status)
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
    // Generation-end publication alone must wake delivery without an intervening journal write.
    const first = liveTestJournalRows(database.db, SESSION).find((row) => row.seq > before)
    expect(JSON.parse(first?.rowJson ?? '{}')).toMatchObject({
      kind: 'submission',
      queuedMessageId: card?.messageId
    })
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
    expect(view.phone()?.status).toBe('attention')
    expect(work.activeTurnId()).toBe('unfinished')
    expect(work.actionablePromptIds()).toEqual([APPROVAL_ID])
    const page = await hydration(current)
    expect(page.latestTurn?.turn).toMatchObject({ turnId: 'unfinished', state: 'running' })
    expect(page.actionablePromptIds).toEqual([APPROVAL_ID])
    expect(page.working).toBe(true)
    await vi.waitFor(() => expect(view.chat().actionablePromptIds).toEqual([APPROVAL_ID]))
    expect(view.chat().working).toBe(true)
    expect(runningStructuredAgentSessionTurnId(view.chat())).toBe('unfinished')
    expect(view.answerable()).toBe(true)
    expect(view.listed()?.status).not.toBe('idle')
  })
})

it('reuses token deltas but refreshes pending prompt dependencies', async () => {
  rig = await createQueuedMessageTestRig()
  await rig.workingSend()
  await leaveUnfinishedWork(rig, { prompt: true })
  const journal = currentJournal(rig)
  const before = currentWork(rig).actionablePrompts()
  expect(before.map((item) => item.itemId)).toContain(APPROVAL_ID)
  const visits = vi.spyOn(journal, 'visitItems')
  const token = { provider: 'codex' as const, threadId: 'tokens', turnId: 'tokens', ordinal: 1 }
  const body = { kind: 'message' as const, role: 'assistant' as const, blocks: [] }
  await journal.appendItem(token, body, { fence: 1, turnScope: { kind: 'thread' } })
  expect(currentWork(rig).actionablePrompts()).toBe(before)
  expect(visits).not.toHaveBeenCalled()
  await journal.appendTombstone(APPROVAL, { fence: 1 })
  expect(currentWork(rig).actionablePromptIds()).toEqual([])
  expect(visits).toHaveBeenCalledOnce()
  await leaveUnfinishedWork(rig, { prompt: true })
  expect(currentWork(rig).actionablePromptIds()).toContain(APPROVAL_ID)
  visits.mockClear()
  for (let n = 0; n < 201; n++) {
    await journal.appendItem(token, body, { fence: 1, turnScope: { kind: 'thread' } })
  }
  expect(currentWork(rig).actionablePromptIds()).toContain(APPROVAL_ID)
  expect(visits).toHaveBeenCalledOnce()
})
