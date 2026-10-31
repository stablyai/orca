import { structuredAgentSessionSeedCatalog } from '../../../shared/structured-agent-session-seed-catalog'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState
} from '../../../shared/structured-agent-session-options'
import {
  structuredAgentSessionMessageSelection,
  structuredAgentSessionShownSnapshot
} from '../../../shared/structured-agent-session-option-view'
import { piOptionRefreshHost } from './structured-agent-session-option-refresh.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { JournalStopAcceptor } from '../agent-session-journal/journal-stop-acceptance'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import {
  HOST_TEST_SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { holdDelivery } from './structured-agent-session-delivery-hold.test-fixture'
import {
  QUEUED_RIG_CALLER,
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { openRigTurnFor } from './structured-agent-session-queued-rig-turn.test-fixture'
import { sameQueuePause } from './structured-agent-session-queued-publication'
import { structuredQueuePauses } from './structured-agent-session-queued-pause'
import { createAgentModelCatalogService } from '../agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../agent-model-catalog/agent-model-catalog-store'
import { agentModelCatalogFingerprintForRecord } from '../agent-model-catalog/agent-model-catalog-fingerprint'

import { createStructuredSessionObservationClock } from './structured-agent-session-observation-clock.test-fixture'

let rig: QueuedMessageTestRig
const observationClock = createStructuredSessionObservationClock(() => rig.host, HOST_TEST_SESSION)
beforeEach(() => observationClock.start())
afterEach(() => observationClock.restore())

function installRigLifecycleHooks(): void {
  beforeEach(async () => {
    rig = await createQueuedMessageTestRig({ restartable: true })
  })

  afterEach(() => observationClock.restoreBeforeCleanup(() => rig.dispose()))
}

async function expectPaused(...draftIds: string[]): Promise<void> {
  await observationClock.observe(250)
  for (const draftId of draftIds) {
    expect(await rig.handoff(draftId)).toBeUndefined()
  }
  expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
}

/** Include unpublished restart holds. */
function derivedPauses(): string[] {
  const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
  if (!journal) {
    throw new Error('expected the conversation open')
  }
  return structuredQueuePauses(journal).map((pause) => pause.reason)
}

async function queuedDraft(text: string): Promise<string> {
  const queued = await rig.send(text, 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  return queued.value.queued.messageId
}

async function stoppedDraft(): Promise<string> {
  const working = await rig.workingSend()
  const draftId = await queuedDraft('paused by stop')
  await rig.stop()
  await rig.settleAccepted(working, 'stopped')
  return draftId
}

function laneDrained(): Promise<void> {
  return rig.host.collaboratorsForTests().serialize(HOST_TEST_SESSION, async () => {})
}

async function handedOver(draftId: string): Promise<void> {
  await eventually(async () => expect((await rig.handoff(draftId))?.handedOverAt).toBeDefined())
}

async function handedOverUserSend(text: string): Promise<string> {
  const { id, result } = rig.send(text)
  expect(await result).toMatchObject({ ok: true, value: { submission: expect.anything() } })
  await eventually(async () => expect((await rig.submission(id))?.handedOverAt).toBeDefined())
  return id
}

describe("a Stop's queue pause", () => {
  installRigLifecycleHooks()

  it('keeps accepted execution and fingerprint exact through catalog refresh, restart, later picks and replay', async () => {
    const working = await rig.workingSend()
    const record = rig.store.getRecord(HOST_TEST_SESSION)!
    const catalogStore = new AgentModelCatalogStore()
    const models = (efforts: string[]) => [
      {
        id: 'openai/model',
        label: 'GPT-5',
        isDefault: false,
        efforts: efforts.map((value) => ({ value, label: value }))
      }
    ]
    const catalog = createAgentModelCatalogService({
      store: catalogStore,
      getRecord: (id) => rig.store.getRecord(id) ?? undefined,
      getConversation: (id) => rig.store.getConversation(id) ?? undefined,
      drivesRecord: () => true,
      resolveAccountHome: async () => record.accountHome
    })
    await catalog.prepareSaved?.({
      agent: record.provider,
      sessionId: HOST_TEST_SESSION,
      inSessionWorkspace: true
    })
    rig.host.deps.modelCatalog = catalog
    rig.host.deps.adapter.readOptions = async () => ({ models: [], current: {} })
    const key = agentModelCatalogFingerprintForRecord(record)
    catalogStore.recordSuccess(
      key,
      record.provider,
      {
        models: models(['medium', 'high']),
        origin: 'probe',
        complete: true
      },
      'discovery'
    )
    const pi = piOptionRefreshHost()
    const seed = structuredAgentSessionSeedCatalog('pi')
    const view = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('pi', seed),
      seed,
      await pi.read()
    )
    expect(
      structuredAgentSessionShownSnapshot(view).find(({ id }) => id === 'effort')?.kind.currentValue
    ).toBe('xhigh')
    const selection = structuredAgentSessionMessageSelection(view)
    expect(selection).toEqual({ model: 'openai/model', effort: 'medium' })
    const body = hostTestMessage('frozen medium')
    const fields = {
      body,
      delivery: 'queue-if-active' as const,
      selection
    }
    const params = {
      ...fields,
      envelope: rig.envelope(fields, 'agentSession.send', hostTestOperationId())
    }
    const queued = await rig.host.send(QUEUED_RIG_CALLER, params)
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected queued receipt')
    }
    const id = queued.value.queued.messageId
    const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
    const frozen = { ...journal.queuedMessages.get(id) }
    const refresh = vi.fn(async () => ({
      models: models(['off', 'minimal', 'low', 'xhigh']),
      origin: 'probe' as const,
      complete: true
    }))
    await catalogStore.refresh(key, record.provider, refresh, () => true)
    expect(refresh).toHaveBeenCalledTimes(1)
    const refreshed = await rig.host.readOptions(HOST_TEST_SESSION)
    expect(
      refreshed.models
        .find((row) => row.id === fields.selection.model)
        ?.efforts.map((choice) => choice.value)
    ).toEqual(['off', 'minimal', 'low', 'xhigh'])
    expect(journal.queuedMessages.get(id)?.options).toEqual(fields.selection)
    const pick = { key: 'effort', value: 'high' }
    expect(
      await rig.host.setOption(QUEUED_RIG_CALLER, {
        ...pick,
        envelope: rig.envelope(pick, 'agentSession.setOption', hostTestOperationId())
      })
    ).toMatchObject({ ok: true })
    await rig.restartHostProcess()
    rig.host.deps.modelCatalog = catalog
    expect(await rig.host.send(QUEUED_RIG_CALLER, params)).toMatchObject({
      ok: true,
      replayed: true
    })
    await rig.settleAccepted(working, 'before-restart')
    expect(await rig.sendNow(id)).toMatchObject({ ok: true })
    await eventually(async () => {
      const submitted = await rig.handoff(id)
      expect(submitted?.options).toEqual(fields.selection)
      const dispatched = rig.dispatch.mock.calls.find(
        ([input]) => input.clientMessageId === submitted?.clientMessageId
      )
      expect(dispatched?.[0].executionOptions).toEqual(fields.selection)
    })
    const restored = rig.host
      .collaboratorsForTests()
      .sessions.get(HOST_TEST_SESSION)!
      .journal.queuedMessages.get(id)
    expect(restored?.fingerprint).toBe(frozen.fingerprint)
    expect(restored?.options).toEqual(fields.selection)
    catalog.stop()
  })

  it('outlives a user send the provider accepts and then refuses; a later send that starts lifts it', async () => {
    const draftId = await stoppedDraft()
    const refused = await handedOverUserSend('the start fails')
    // Hide pause during the lifting send, restoring it if refused.
    expect(await rig.queuePause()).toBeNull()
    await rig.settleRejected(refused, 'turn/start refused')
    await expectPaused(draftId)
    const started = await handedOverUserSend('this one starts')
    await rig.settleAccepted(started, 'started')
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
  })

  it('a Stop after the user send supersedes it: that send starting its turn lifts nothing', async () => {
    const draftId = await stoppedDraft()
    const earlier = await handedOverUserSend('sent before the second stop')
    await rig.stop()
    await rig.settleAccepted(earlier, 'late')
    await expectPaused(draftId)
  })

  it('survives a restart, and a send made after the Stop still ends it when its turn starts there', async () => {
    const draftId = await stoppedDraft()
    const inFlight = await handedOverUserSend('sent before the restart')
    // Crash without close; persisted journal state must still derive both pauses.
    rig.crashRestartHostProcess()
    expect(await rig.queuePause()).toBeNull()
    expect(derivedPauses()).toEqual(['stopped', 'restarted'])
    await rig.settleAccepted(inFlight, 'after-restart')
    // Pre-restart acceptance lifts Stop only; restart still needs a later turn.
    await eventually(async () => expect(derivedPauses()).toEqual(['restarted']))
    expect(await rig.queuePause()).toBeNull()
    expect(await rig.handoff(draftId)).toBeUndefined()
    const next = rig.send('sent after the restart')
    await next.result
    await rig.settleAccepted(next.id, 'next')
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
  })

  it("a draft typed after the Stop waits with the rest: the pause is the queue's", async () => {
    await rig.workingSend()
    const olderId = await queuedDraft('paused by the stop')
    await rig.stop()
    await laneDrained()

    const refused = await handedOverUserSend('sent after the stop')
    const typedId = await queuedDraft('typed while that send waits')
    await rig.settleRejected(refused, 'turn/start refused')
    await expectPaused(olderId, typedId)
    expect(await rig.drafts()).toEqual([
      { messageId: olderId, state: 'waiting' },
      { messageId: typedId, state: 'waiting' }
    ])
  })

  it('Send-now sends only its own card; the rest stay paused until that turn starts, then drain after it', async () => {
    const working = await rig.workingSend()
    const sentId = await queuedDraft('sent now')
    const heldId = await queuedDraft('held until that turn starts')
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    expect(await rig.sendNow(sentId)).toMatchObject({
      ok: true,
      value: { submission: { queuedMessageId: sentId } }
    })
    await handedOver(sentId)
    // Only the selected card leaves; hidden pause still holds the rest.
    await observationClock.observe(250)
    expect(await rig.handoff(heldId)).toBeUndefined()
    expect(derivedPauses()).toEqual(['stopped'])
    expect(await rig.queuePause()).toBeNull()
    expect(await rig.drafts()).toEqual([{ messageId: heldId, state: 'waiting' }])
    await rig.settleAccepted(await rig.handoffId(sentId), 'sent-now')
    await eventually(async () => expect(await rig.handoff(heldId)).toBeDefined())
  })

  it('a card sent now that the provider refuses lifts nothing', async () => {
    const working = await rig.workingSend()
    // Put waiting work ahead of the returned card so Resume has actionable work.
    const heldId = await queuedDraft('held by the stop')
    const sentId = await queuedDraft('sent now, refused')
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    await rig.sendNow(sentId)
    await handedOver(sentId)
    await rig.settleRejected(await rig.handoffId(sentId), 'turn/start refused')
    await expectPaused(heldId)
  })

  it('an old send answered again after its receipt is gone lifts nothing from a later Stop', async () => {
    const working = await rig.workingSend()
    const draftId = await queuedDraft('paused by stop')
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    // Model legacy no-receipt acceptance that must reconstruct its result.
    openTestJournalHostDatabase(rig.root)
      .db.prepare('DELETE FROM agent_session_command_receipts WHERE operation_id = ?')
      .run(working)
    const body = hostTestMessage('work on this')
    const replayed = await rig.host.send(QUEUED_RIG_CALLER, {
      envelope: rig.envelope({ body }, 'agentSession.send', working),
      body
    })
    expect(replayed).toMatchObject({
      ok: true,
      replayed: false,
      value: { submission: { dispatchState: 'accepted' } }
    })
    // Later commits cannot make pre-Stop acceptance lift the pause.
    rig
      .providerEvents()
      .appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'turn-later', ordinal: 901 },
        { kind: 'turn', turnId: 'turn-later', state: 'completed', startedAt: 1 },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    await expectPaused(draftId)
  })
})

describe('the pause read', () => {
  installRigLifecycleHooks()

  it('costs no scan of the submissions: the reducer keeps the latest accepted turn', async () => {
    const draftId = await stoppedDraft()
    const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
    if (!journal) {
      throw new Error('expected the conversation open')
    }
    const scan = vi.spyOn(journal, 'submissions')
    // This per-publication read must not scan submissions.
    expect(structuredQueuePauses(journal)).toMatchObject([{ reason: 'stopped' }])
    expect(scan).not.toHaveBeenCalled()
    scan.mockRestore()
    const mail = rig.send('coordinator mail')
    await mail.result
    expect(structuredQueuePauses(journal)).toMatchObject([{ reason: 'stopped' }])
    await rig.settleAccepted(mail.id, 'mail')
    expect(structuredQueuePauses(journal)).toEqual([])
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
  })
})

describe('a card queued after a Stop is a new instruction', () => {
  installRigLifecycleHooks()

  it('a correction typed after a Stop over an empty queue goes straight to the next agent', async () => {
    await rig.workingSend()
    await rig.stop()

    const correction = await rig.send('typed right after the stop', 'queue-if-active').result
    expect(correction).toMatchObject({ ok: true, value: { submission: { fence: 2 } } })
    expect(await rig.drafts()).toEqual([])
    expect(await rig.queuePause()).toBeNull()
  })

  it('a card sent now before the Stop and taken anyway lifts nothing, and holds nothing typed later', async () => {
    const working = await rig.workingSend()
    await openRigTurnFor(rig, working)
    const sentId = await queuedDraft('sent now into the turn')
    await rig.sendNow(sentId)
    await handedOver(sentId)
    await rig.stop()
    expect(await rig.queuePause()).toBeNull()
    await rig.settleAccepted(await rig.handoffId(sentId), 'sent-now')
    await rig.settleAccepted(working, 'stopped')
    await openRigTurnFor(rig, working, 'interrupted')
    const mail = rig.send('coordinator mail')
    await mail.result
    await eventually(async () =>
      expect((await rig.submission(mail.id))?.handedOverAt).toBeDefined()
    )
    const later = await queuedDraft('typed during the mail turn')
    await rig.settleAccepted(mail.id, 'mail')
    await eventually(async () => expect(await rig.handoff(later)).toBeDefined())
    expect(derivedPauses()).toEqual([])
  })

  it("deleting the last paused card hides the pause; a person's next turn is what ends it", async () => {
    const working = await rig.workingSend()
    const only = await queuedDraft('paused, then deleted')
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    expect(await rig.deleteQueued(only)).toMatchObject({ ok: true, value: { deleted: true } })
    expect(await rig.queuePause()).toBeNull()
    const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
    if (!journal) {
      throw new Error('expected the conversation open')
    }
    // No cards can display the hidden hold; inspect its journal projection.
    expect(structuredQueuePauses(journal)).toMatchObject([{ reason: 'stopped' }])
    const next = await rig.workingSend()
    const later = await queuedDraft('typed during the next turn')
    expect(structuredQueuePauses(journal)).toMatchObject([{ reason: 'stopped' }])
    await rig.settleAccepted(next, 'next')
    expect(structuredQueuePauses(journal)).toEqual([])
    await eventually(async () => expect(await rig.handoff(later)).toBeDefined())
  })
})

describe('a pause only over cards Resume could send', () => {
  installRigLifecycleHooks()

  it('a Stop that leaves only a returned card publishes no pause', async () => {
    const working = await rig.workingSend()
    const draftId = await queuedDraft('refused before the stop')
    await rig.settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
    await rig.settleRejected(await rig.handoffId(draftId), 'provider refused this payload')
    await eventually(async () =>
      expect(await rig.drafts()).toEqual([{ messageId: draftId, state: 'returned' }])
    )
    const next = await handedOverUserSend('sent past the card')
    expect(await rig.stop()).toMatchObject({ ok: true })
    await rig.settleAccepted(next, 'stopped')
    expect(await rig.queuePause()).toBeNull()
    const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
    expect(journal && structuredQueuePauses(journal)).toMatchObject([{ reason: 'stopped' }])
  })

  it('a returned card blocking the paused cards hides the pause but keeps it; deleting that card shows it again, and only Resume sends', async () => {
    const working = await rig.workingSend()
    const refusedId = await queuedDraft('refused after the stop')
    const behindId = await queuedDraft('waits behind the card')
    await rig.settleAccepted(working, 'a')
    await handedOver(refusedId)
    await rig.stop()
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    await rig.settleRejected(await rig.handoffId(refusedId), 'provider refused this payload')
    await eventually(async () =>
      expect(await rig.drafts()).toEqual([
        { messageId: refusedId, state: 'returned' },
        { messageId: behindId, state: 'waiting' }
      ])
    )
    const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
    if (!journal) {
      throw new Error('expected the conversation open')
    }
    // Hide Resume when a returned head blocks it, retaining the derived pause.
    expect(await rig.queuePause()).toBeNull()
    expect(structuredQueuePauses(journal)).toMatchObject([{ reason: 'stopped' }])
    expect(await rig.deleteQueued(refusedId)).toMatchObject({ ok: true, value: { deleted: true } })
    await expectPaused(behindId)
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await eventually(async () => expect(await rig.handoff(behindId)).toBeDefined())
  })

  it('a restart over only a card held by its own failed send publishes no pause', async () => {
    const working = await rig.workingSend()
    const draftId = await queuedDraft('conversion fails once')
    const append = vi
      .spyOn(AgentSessionJournal.prototype, 'appendSubmission')
      .mockImplementationOnce(async () => {
        throw new Error('disk full')
      })
    try {
      await rig.settleAccepted(working, 'a')
      await eventually(async () =>
        expect(await rig.drafts()).toEqual([{ messageId: draftId, state: 'waiting', paused: true }])
      )
    } finally {
      append.mockRestore()
    }
    await rig.restartHostProcess()
    expect(await rig.queuePause()).toBeNull()
  })
})

describe('comparing queue pauses', () => {
  it('compares a pause by presence before reason, so appearing or clearing is always a change', () => {
    expect(sameQueuePause(null, {})).toBe(false)
    expect(sameQueuePause({}, null)).toBe(false)
    expect(sameQueuePause(null, null)).toBe(true)
    expect(sameQueuePause({ reason: 'stopped' }, { reason: 'stopped' })).toBe(true)
    expect(sameQueuePause({ reason: 'stopped' }, { reason: 'cleared' })).toBe(false)
  })
})

describe("a restart's pause", () => {
  installRigLifecycleHooks()

  it('a turn ends it; closing again with a card still waiting holds that card again', async () => {
    const working = await rig.workingSend()
    const first = await queuedDraft('first')
    const second = await queuedDraft('second')
    await rig.restartHostProcess()
    await rig.settleAccepted(working, 'a')
    expect(await rig.queuePause()).toBeNull()
    expect(derivedPauses()).toEqual(['restarted'])
    const next = rig.send('user starts a new turn')
    await next.result
    await rig.settleAccepted(next.id, 'b')
    await eventually(async () => expect(await rig.handoff(first)).toBeDefined())
    await rig.host.close(HOST_TEST_SESSION, 'evict')
    expect(await rig.queuePause()).toBeNull()
    expect(await rig.drafts()).toContainEqual({ messageId: second, state: 'waiting' })
    expect(derivedPauses()).toEqual(['restarted'])
  })
})

describe('a card handed off after a restart', () => {
  installRigLifecycleHooks()

  // Returned cards are not held by reopen; only personal Stop holds this one.
  it('sent again and withdrawn by a Stop, it waits under that Stop alone, shown; Resume lifts it', async () => {
    const working = await rig.workingSend()
    const draftId = await queuedDraft('refused, then re-sent after a restart')
    await rig.settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
    await rig.settleRejected(await rig.handoffId(draftId), 'provider refused this payload')
    await eventually(async () =>
      expect(await rig.drafts()).toEqual([{ messageId: draftId, state: 'returned' }])
    )
    await rig.restartHostProcess()
    // Hold delivery so Stop precedes the restarted handoff’s provider call.
    const { held, release } = holdDelivery()
    const handedOver = rig.dispatch.mock.calls.length
    const sending = rig.sendNow(draftId)
    await held
    const stopping = rig.stop()
    release()
    expect(await sending).toMatchObject({ ok: true })
    await stopping
    expect(rig.dispatch).toHaveBeenCalledTimes(handedOver)
    await eventually(async () =>
      expect(await rig.drafts()).toEqual([{ messageId: draftId, state: 'waiting' }])
    )
    expect(derivedPauses()).toEqual(['stopped'])
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    expect(derivedPauses()).toEqual([])
  })
})

describe('Resume', () => {
  installRigLifecycleHooks()

  it('lifts the pause and the queue drains, oldest first; a second Resume is a no-op', async () => {
    const working = await rig.workingSend()
    const first = await queuedDraft('first')
    const second = await queuedDraft('second')
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    await expectPaused(first, second)
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    expect(await rig.queuePause()).toBeNull()
    await eventually(async () => expect(await rig.handoff(first)).toBeDefined())
    expect(await rig.handoff(second)).toBeUndefined()
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: false } })
  })

  it('is idempotent: a replay of the same Resume answers without lifting a later pause', async () => {
    await rig.workingSend()
    const draftId = await queuedDraft('paused twice')
    await rig.stop()
    const operationId = hostTestOperationId()
    const { held, release } = holdDelivery()
    expect(await rig.resume(operationId)).toMatchObject({ ok: true, value: { resumed: true } })
    await held

    const stopping = rig.stop()
    release()
    await stopping
    await eventually(async () =>
      expect(await rig.drafts()).toEqual([{ messageId: draftId, state: 'waiting' }])
    )
    const withdrawn = await rig.handoffId(draftId)
    expect(await rig.resume(operationId)).toMatchObject({
      ok: true,
      replayed: true,
      value: { resumed: false }
    })
    await observationClock.observe(250)
    expect(await rig.handoffId(draftId)).toBe(withdrawn)
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
  })

  it("of a Stop from before a restart, which no client offers there, also lifts the restart's pause", async () => {
    const draftId = await stoppedDraft()
    rig.crashRestartHostProcess()
    expect(await rig.queuePause()).toBeNull()
    expect(derivedPauses()).toEqual(['stopped', 'restarted'])
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
  })

  it('is a no-op on a queue that is not paused', async () => {
    await rig.workingSend()
    await queuedDraft('waiting behind the turn')
    expect(await rig.queuePause()).toBeNull()
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: false } })
  })
})

describe('a failed Stop', () => {
  installRigLifecycleHooks()

  it('pauses nothing and interrupts nothing when its acceptance cannot be saved', async () => {
    await rig.workingSend()
    await queuedDraft('queued before the stop')
    const accept = vi
      .spyOn(JournalStopAcceptor.prototype, 'accept')
      .mockRejectedValueOnce(new Error('disk full'))
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(await rig.stop()).toMatchObject({
        ok: false,
        refusal: { details: { reason: 'stopFailed' } }
      })
    } finally {
      accept.mockRestore()
      warned.mockRestore()
    }
    expect(rig.cancelTurn).not.toHaveBeenCalled()
    expect(await rig.queuePause()).toBeNull()
  })

  it('keeps its pause when its note fails after the interrupt reached the agent', async () => {
    await openRigTurnFor(rig, await rig.workingSend())
    const draftId = await queuedDraft('paused by stop')
    const append = AgentSessionJournal.prototype.appendItem
    const failing = vi
      .spyOn(AgentSessionJournal.prototype, 'appendItem')
      .mockImplementation(async function (this: AgentSessionJournal, ...args) {
        if (args[1].kind === 'status') {
          throw new Error('disk full')
        }
        return append.apply(this, args)
      })
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      // Post-interrupt failure cannot undo the committed Stop receipt.
      expect(await rig.stop()).toMatchObject({ ok: true })
      expect(failing).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ kind: 'status' }),
        expect.anything()
      )
    } finally {
      failing.mockRestore()
      warned.mockRestore()
    }
    await expectPaused(draftId)
  })
})
