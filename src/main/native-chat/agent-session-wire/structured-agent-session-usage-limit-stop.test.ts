import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { latestUsageLimitContinueIdentity } from '../../../shared/native-chat/native-chat-usage-limit-cut'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import * as liveTurn from '../../../shared/agent-session/view/structured-agent-session-live-turn'
import * as commands from '../../../shared/agent-session/structured-agent-session-command-entry'
import * as usageLimitCut from '../../../shared/native-chat/native-chat-usage-limit-cut'
import { createCodexJournalTranslator } from '../../codex/codex-structured-journal-translation'
import * as reducer from '../agent-session-journal/journal-reducer'
import * as publicRead from '../agent-session-journal/journal-public-read'
import * as stoppedCut from '../agent-session-journal/journal-stopped-usage-limit-cut'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store-test-harness'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { openTestAttachConversation } from './structured-agent-session-attach-test-conversation'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'

const CODEX_WORDS = "You've hit your usage limit. Try again in 1 minute."
let clock = 0
let rig: QueuedMessageTestRig

beforeEach(async () => {
  // Codex bounds a reported reset against the wall clock; keep it at the host's time.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  clock = NOW
  rig = await createQueuedMessageTestRig({ now: () => clock, restartable: true })
  await rig.store.setSessionTabVisibility(SESSION, true)
  autoContinueOn(rig.host)
})
function forgetTranslator() {
  translator?.dispose()
  translator = undefined
}
afterEach(async () => {
  forgetTranslator()
  await rig?.dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function autoContinueOn(host: StructuredAgentSessionHost) {
  host.deps.usageLimitAutoContinue = {
    isEnabled: () => true,
    isWorkspaceAsleep: () => false,
    subscribe: () => () => {}
  }
}

function journal() {
  return rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
}

let translator: ReturnType<typeof createCodexJournalTranslator> | undefined
/** Real Codex app-server notifications through one production translator into the host's sink. */
function codex() {
  translator ??= createCodexJournalTranslator({
    sink: rig.providerEvents(),
    sessionId: SESSION,
    primaryThreadId: () => THREAD,
    now: () => clock
  })
  const current = translator
  return (method: string, params: Record<string, unknown>) =>
    current.handle({
      type: 'notification',
      sessionId: SESSION,
      threadId: THREAD,
      method,
      params
    })
}

/** A person's send that Codex accepted and started as `turnId`. */
async function codexTurnAccepted(turnId: string) {
  const id = await rig.workingSend()
  await rig.settleAccepted(id, turnId.replace('turn-', ''))
  // Each acquisition has its own translator, as in the adapter.
  forgetTranslator()
  codex()('turn/started', { threadId: THREAD, turn: { id: turnId, status: 'inProgress' } })
  await rig.host.flushStreamedEvents(SESSION)
}

/** The usage report, the quota error and the failed completion Codex sends for a spent window. */
async function codexLimitedEnd(turnId: string, resetsInS: number) {
  const notify = codex()
  notify('account/rateLimits/updated', {
    rateLimits: {
      limitId: 'codex',
      primary: {
        usedPercent: 100,
        windowDurationMins: 300,
        resetsAt: Math.floor(clock / 1000) + resetsInS
      }
    }
  })
  notify('error', {
    threadId: THREAD,
    turnId,
    willRetry: false,
    error: { codexErrorInfo: 'usageLimitExceeded', message: CODEX_WORDS }
  })
  notify('turn/completed', { threadId: THREAD, turn: { id: turnId, status: 'failed' } })
  await rig.host.flushStreamedEvents(SESSION)
}

async function currentCut() {
  const cut = latestUsageLimitContinueIdentity(await rig.host.journalSnapshot(SESSION))
  expect(cut).toBeDefined()
  return cut!
}

async function expectNoAutomaticContinue(host: StructuredAgentSessionHost, resetsAt: number) {
  clock = resetsAt + 16_000
  const sent = vi.spyOn(host, 'send')
  await host.usageLimitContinue.tick()
  await host.usageLimitContinue.tick()
  expect(sent).not.toHaveBeenCalled()
  expect(host.usageLimitContinue.readState(SESSION)?.state).toBe('cancelled')
  sent.mockRestore()
}

async function reopen() {
  forgetTranslator()
  await rig.quitRestartHostProcess()
  autoContinueOn(rig.host)
}

describe('a Stop accepted before a usage limit ends the turn', () => {
  it('withdraws the automatic continuation its failed end reveals, through reopen', async () => {
    await codexTurnAccepted('turn-1')
    expect(await rig.stop()).toMatchObject({ ok: true })
    await codexLimitedEnd('turn-1', 60)

    const first = await currentCut()
    expect(rig.store.getRecord(SESSION)?.usageLimitContinueCancel).toEqual(first)
    // A refined reset for the same stopped turn is withdrawn too.
    await codexLimitedEnd('turn-1', 120)
    const cut = await currentCut()
    expect(cut).toEqual({ turnItemId: first.turnItemId, resetsAt: first.resetsAt + 60_000 })
    expect(rig.store.getRecord(SESSION)?.usageLimitContinueCancel).toEqual(cut)
    await expectNoAutomaticContinue(rig.host, cut.resetsAt)
    await reopen()
    expect(
      (await openTestAgentSessionRecordStore(rig.root)).getRecord(SESSION)?.usageLimitContinueCancel
    ).toEqual(cut)
    await expectNoAutomaticContinue(rig.host, cut.resetsAt)
  })

  it('withdraws a cut that commits between the Stop snapshot and its acceptance', async () => {
    await codexTurnAccepted('turn-1')
    const accept = journal().stops.accept.bind(journal().stops)
    vi.spyOn(journal().stops, 'accept').mockImplementationOnce(async (...args) => {
      await codexLimitedEnd('turn-1', 60)
      return accept(...args)
    })
    expect(await rig.stop()).toMatchObject({ ok: true })

    const cut = await currentCut()
    expect(rig.store.getRecord(SESSION)?.usageLimitContinueCancel).toEqual(cut)
    await expectNoAutomaticContinue(rig.host, cut.resetsAt)
  })

  it('keeps it withdrawn after Resume and deleting an unsent card', async () => {
    await codexTurnAccepted('turn-1')
    const queued = await rig.send('next', 'queue-if-active').result
    expect(queued).toMatchObject({ ok: true })
    const [draft] = await rig.drafts()
    const card = journal().queuedMessages.get(draft!.messageId)!
    expect(
      await rig.host.queuedMessageEditHold(QUEUED_RIG_CALLER, {
        sessionId: SESSION,
        messageId: card.messageId,
        editId: 'edit-1',
        action: 'acquire',
        expectedBodyFingerprint: card.fingerprint
      })
    ).toMatchObject({ status: 'held' })
    expect(await rig.stop()).toMatchObject({ ok: true })
    await codexLimitedEnd('turn-1', 60)
    const stopped = await currentCut()
    expect(await rig.resume()).toMatchObject({ ok: true })
    expect(await rig.deleteQueued(card.messageId)).toMatchObject({ ok: true })
    await reopen()
    await expectNoAutomaticContinue(rig.host, stopped.resetsAt)
  })

  it('continues a later limited turn that the Stop did not reach', async () => {
    await codexTurnAccepted('turn-1')
    expect(await rig.stop()).toMatchObject({ ok: true })
    await codexLimitedEnd('turn-1', 60)
    const stopped = await currentCut()

    // A person's next request is new work: its own limited end continues as usual.
    await codexTurnAccepted('turn-2')
    await codexLimitedEnd('turn-2', 120)
    const later = await currentCut()
    expect(later.turnItemId).not.toBe(stopped.turnItemId)
    expect(rig.host.usageLimitContinue.readState(SESSION)?.state).toBe('scheduled')
    clock = later.resetsAt + 16_000
    const sent = vi.spyOn(rig.host, 'send')
    await rig.host.usageLimitContinue.tick()
    await eventually(() => expect(sent).toHaveBeenCalledOnce())
    expect(sent.mock.calls[0]?.[1].usageLimitContinuationOfTurnItemId).toBe(later.turnItemId)
  })

  it('commits the withdrawal with the rows that reveal the cut, or neither', async () => {
    await rig.settleAccepted(await rig.workingSend(), '1')
    const fence = rig.store.getRecord(SESSION)!.lease.runtimeFence
    const turnItem = {
      provider: 'codex' as const,
      threadId: THREAD,
      turnId: 'turn-1',
      ordinal: 900
    }
    const turnItemId = agentJournalItemKey(turnItem)
    const turn = (state: 'running' | 'completed') =>
      journal().appendItem(
        turnItem,
        {
          kind: 'turn',
          turnId: 'turn-1',
          state,
          startedAt: 1,
          ...(state === 'completed' ? { outcome: 'failure' as const, completedAt: clock } : {})
        },
        { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    await turn('running')
    await journal().appendItem(
      { provider: 'orca', clientMessageId: 'limit' },
      {
        kind: 'status',
        ...agentSessionFailureWords(
          agentSessionFailureFact('usageLimitReached', {
            usageLimit: { resetsAt: clock + 60_000 }
          }),
          { surface: 'row' }
        )
      },
      { fence, turnScope: { kind: 'turn', turnItemId } }
    )
    const receipt = rig.store.usageLimitContinueCancelReceipt.bind(rig.store)
    let failed = false
    // Fail every revealing commit (the explicit end below, or the agent's own exit settlement).
    const failing = vi
      .spyOn(rig.store, 'usageLimitContinueCancelReceipt')
      .mockImplementation((id, cut) => {
        const real = receipt(id, cut)!
        return {
          ...real,
          write: (db) => {
            real.write(db)
            failed = true
            throw new Error('disk full')
          }
        }
      })
    expect(await rig.stop()).toMatchObject({ ok: true })
    await expect(turn('completed')).rejects.toThrow('disk full')
    expect(failed).toBe(true)
    // Neither the ending nor its withdrawal is visible, in memory or on disk.
    expect(
      latestUsageLimitContinueIdentity(await rig.host.journalSnapshot(SESSION))
    ).toBeUndefined()
    expect(rig.store.getRecord(SESSION)?.usageLimitContinueCancel).toBeUndefined()
    expect(
      (await openTestAgentSessionRecordStore(rig.root)).getRecord(SESSION)?.usageLimitContinueCancel
    ).toBeUndefined()

    failing.mockRestore()
    await turn('completed')
    const cut = await currentCut()
    expect(cut.turnItemId).toBe(turnItemId)
    expect(rig.store.getRecord(SESSION)?.usageLimitContinueCancel).toEqual(cut)
    // Memory adopted exactly what was saved, with no other store change lost (reopen marks leases).
    const saved = (await openTestAgentSessionRecordStore(rig.root)).getRecord(SESSION)!
    expect({ ...saved, lease: { ...saved.lease, unreconciled: false } }).toEqual(
      rig.store.getRecord(SESSION)
    )
    await reopen()
    await expectNoAutomaticContinue(rig.host, cut.resetsAt)
  })
})

/** Work counted only inside the Stop's commit hook and the status projection's cut reader. */
function countCommitWork() {
  const counts = { hooks: 0, scans: 0, renders: 0, fullRenders: 0, cutReads: 0, indexes: 0 }
  let inside: 'hook' | 'cut' | null = null
  const hook = stoppedCut.journalStoppedUsageLimitCut
  vi.spyOn(stoppedCut, 'journalStoppedUsageLimitCut').mockImplementation((state, rows) => {
    counts.hooks++
    inside = 'hook'
    try {
      return hook(state, rows)
    } finally {
      inside = null
    }
  })
  const newest = liveTurn.newestStructuredAgentSessionTurnBySequence
  vi.spyOn(liveTurn, 'newestStructuredAgentSessionTurnBySequence').mockImplementation((items) => {
    counts.scans += inside === 'hook' ? 1 : 0
    return newest(items)
  })
  const render = reducer.renderJournalState
  vi.spyOn(reducer, 'renderJournalState').mockImplementation((state) => {
    counts.fullRenders += inside === 'hook' ? 1 : 0
    return render(state)
  })
  const status = publicRead.renderJournalStatus
  vi.spyOn(publicRead, 'renderJournalStatus').mockImplementation((state, owner) => {
    counts.renders += inside === 'hook' ? 1 : 0
    return status(state, owner)
  })
  const read = usageLimitCut.latestNativeChatUsageLimitCut
  vi.spyOn(usageLimitCut, 'latestNativeChatUsageLimitCut').mockImplementation(
    (items, submissions, bodyOf) => {
      counts.cutReads++
      inside = 'cut'
      try {
        return read(items, submissions, bodyOf)
      } finally {
        inside = null
      }
    }
  )
  const index = commands.structuredAgentSessionCommandTurnItemIds
  vi.spyOn(commands, 'structuredAgentSessionCommandTurnItemIds').mockImplementation((items) => {
    counts.indexes += inside === 'cut' ? 1 : 0
    return index(items)
  })
  const reset = () =>
    Object.assign(counts, {
      hooks: 0,
      scans: 0,
      renders: 0,
      fullRenders: 0,
      cutReads: 0,
      indexes: 0
    })
  return { counts, reset }
}

describe('journal commit work after a Stop', () => {
  it.each([20, 200])(
    'streamed rows scan no history and build no index with %i history rows',
    async (history) => {
      const { counts, reset } = countCommitWork()
      await codexTurnAccepted('turn-1')
      expect(await rig.stop()).toMatchObject({ ok: true })
      await codexLimitedEnd('turn-1', 60)
      // The Stop owns this end, so it rendered once to find the cut it withdraws.
      expect(counts.renders).toBeGreaterThan(0)
      expect(counts.fullRenders).toBe(0)
      expect(rig.store.getRecord(SESSION)?.usageLimitContinueCancel).toEqual(await currentCut())
      const fence = rig.store.getRecord(SESSION)!.lease.runtimeFence
      for (let i = 0; i < history; i++) {
        await journal().appendItem(
          { provider: 'orca', clientMessageId: `history-${i}` },
          { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `old ${i}` }] },
          { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
      }
      await codexTurnAccepted('turn-2')
      reset()

      const streamed = 10
      for (let i = 0; i < streamed; i++) {
        const item = { type: 'agentMessage', id: `reply-${i}`, text: 'x' }
        codex()('item/started', { threadId: THREAD, turnId: 'turn-2', item: { ...item, text: '' } })
        codex()('item/completed', { threadId: THREAD, turnId: 'turn-2', item })
        await rig.host.flushStreamedEvents(SESSION)
      }
      // Every streamed commit ran the hook and the projection, at the same cost for any history.
      expect(counts.hooks).toBeGreaterThanOrEqual(streamed)
      expect(counts.cutReads).toBeGreaterThanOrEqual(streamed)
      expect(counts).toMatchObject({ scans: 0, renders: 0, fullRenders: 0, indexes: 0 })

      reset()
      codex()('turn/completed', { threadId: THREAD, turn: { id: 'turn-2', status: 'completed' } })
      await rig.host.flushStreamedEvents(SESSION)
      // The end scans for the newest turn once; the Stop does not own it, so nothing renders.
      expect(counts).toMatchObject({ scans: 1, renders: 0, fullRenders: 0, indexes: 0 })
    }
  )
})

it('records a Stop and its limited end in a conversation opened without a record store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usage-limit-storeless-'))
  try {
    const record = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: 'storeless' }))
    const opened = await openTestAttachConversation(openTestJournalHostDatabase(root))(record)
    const fence = record.lease.runtimeFence
    await opened.stops.accept({
      event: { reason: 'user-stop', turnId: 'turn-1' },
      fence,
      liveTurnId: () => null
    })
    const turnKey = { provider: 'orca' as const, clientMessageId: 'storeless-turn' }
    const turnItemId = agentJournalItemKey(turnKey)
    await opened.appendItem(
      turnKey,
      {
        kind: 'turn',
        turnId: 'turn-1',
        state: 'completed',
        outcome: 'failure',
        startedAt: 1,
        completedAt: 2
      },
      { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    // There is nothing to withdraw without a store; the revealing commit still lands.
    await opened.appendItem(
      { provider: 'orca', clientMessageId: 'storeless-limit' },
      {
        kind: 'status',
        ...agentSessionFailureWords(
          agentSessionFailureFact('usageLimitReached', { usageLimit: { resetsAt: 60_000 } }),
          { surface: 'row' }
        )
      },
      { fence, turnScope: { kind: 'turn', turnItemId } }
    )
    expect(latestUsageLimitContinueIdentity(opened.snapshot())).toEqual({
      turnItemId,
      resetsAt: 60_000
    })
  } finally {
    await closeTestJournalHostDatabase(root)
    await rm(root, { recursive: true, force: true })
  }
})
