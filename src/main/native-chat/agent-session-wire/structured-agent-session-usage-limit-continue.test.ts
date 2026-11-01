import { afterEach, expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE } from '../../../shared/native-chat/native-chat-usage-limit-cut'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { structuredAgentSessionHostInstance } from './structured-agent-session-queued-pause'
import { holdLane } from './structured-agent-session-delivery-hold.test-fixture'
import {
  hostTestAttachParams,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { refuse } from '../../../shared/agent-session-wire'
import {
  createRestTestRig,
  foundRestTestChat,
  restTestSend,
  REST_TEST_CALLER,
  REST_TEST_SESSION as SESSION,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'

let rig: RestTestRig | undefined
let enabled = true
let asleep = false
let changed = () => {}
afterEach(async () => {
  await rig?.dispose()
  vi.restoreAllMocks()
})

async function setup(stale = false) {
  enabled = true
  asleep = false
  rig = await createRestTestRig({
    idleSweep: { intervalMs: 3_600_000 },
    usageLimitAutoContinue: {
      isEnabled: () => enabled,
      isWorkspaceAsleep: () => asleep,
      subscribe: (cb) => {
        changed = cb
        return () => {}
      }
    }
  })
  const current = rig
  await foundRestTestChat(current)
  const journal = current.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const resetsAt = current.clock.now + (stale ? -1 : 30_000)
  const turnItemId = await limitTurn(journal, resetsAt, current.clock.now)
  const sweep = current.host.usageLimitContinue
  return { current, journal, resetsAt, turnItemId, sweep }
}

async function limitTurn(journal: AgentSessionJournal, resetsAt: number, now: number) {
  const key = { provider: 'orca' as const, clientMessageId: 'limited-turn' }
  const turnItemId = agentJournalItemKey(key)
  await journal.appendItem(
    key,
    {
      kind: 'turn',
      turnId: 'turn-1',
      state: 'completed',
      outcome: 'failure',
      startedAt: now,
      completedAt: now
    },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'limit' },
    {
      kind: 'status',
      ...agentSessionFailureWords(
        { kind: 'usageLimitReached', usageLimit: { resetsAt } },
        { surface: 'row' }
      )
    },
    { fence: 1, turnScope: { kind: 'turn', turnItemId } }
  )
  return turnItemId
}

it('waits for the buffered reset, accepts one ordinary continuation and never sends twice', async () => {
  const { current, sweep, resetsAt } = await setup()
  expect(sweep.readState(SESSION)?.state).toBe('scheduled')
  expect(current.host.readStatusSummary(SESSION)?.usageLimitContinue?.state).toBe('scheduled')
  const send = vi.spyOn(current.host, 'send')
  current.clock.now = resetsAt + 14_999
  await sweep.tick()
  expect(send).not.toHaveBeenCalled()
  current.clock.now++
  await sweep.tick()
  await sweep.tick()
  expect(send).toHaveBeenCalledOnce()
  expect(send.mock.calls[0]?.[0]).toEqual({ callerKey: 'trusted-local:usage-limit-continue' })
  expect(send.mock.calls[0]?.[1].body.blocks).toEqual([
    { type: 'text', text: NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE }
  ])
  expect(sweep.readState(SESSION)).toBeUndefined()
  await vi.waitFor(() => expect(current.adapter.dispatch).toHaveBeenCalledTimes(2))
})

it.each(['cancel', 'off', 'message', 'stale', 'sleep'] as const)(
  'does not continue after %s',
  async (reason) => {
    const { current, sweep, resetsAt, turnItemId } = await setup(reason === 'stale')
    if (reason === 'cancel') {
      await sweep.cancel({ sessionId: SESSION, turnItemId, resetsAt })
      await sweep.cancel({ sessionId: SESSION, turnItemId, resetsAt })
      expect(current.store.getRecord(SESSION)?.usageLimitContinueCancel).toEqual({
        turnItemId,
        resetsAt
      })
      expect(sweep.readState(SESSION)?.state).toBe('cancelled')
      await current.restart()
      expect(current.store.getRecord(SESSION)?.usageLimitContinueCancel).toEqual({
        turnItemId,
        resetsAt
      })
    }
    if (reason === 'off') {
      enabled = false
      changed()
    }
    if (reason === 'sleep') {
      asleep = true
    }
    if (reason === 'message') {
      await current.host.send(REST_TEST_CALLER, restTestSend('new request'))
    }
    const send = vi.spyOn(current.host, 'send')
    current.clock.now = resetsAt + 15_000
    await current.host.usageLimitContinue.tick()
    expect(send).not.toHaveBeenCalled()
  }
)

it('retries refusals after 1, 2, 4 and 8 minutes and publishes failure after five attempts', async () => {
  const { current, sweep, resetsAt } = await setup()
  const send = vi.spyOn(current.host, 'send').mockResolvedValue({
    ok: false,
    refusal: refuse('execution_owner_reconciling', { reason: 'recordUnreadable' })
  })
  current.clock.now = resetsAt + 15_000
  await sweep.tick()
  for (const minutes of [1, 2, 4, 8]) {
    current.clock.now += minutes * 60_000 - 1
    await sweep.tick()
    const calls = send.mock.calls.length
    current.clock.now++
    await sweep.tick()
    expect(send.mock.calls.length).toBe(calls + 1)
  }
  expect(sweep.readState(SESSION)?.state).toBe('failed')
  current.clock.now += 60 * 60_000
  await sweep.tick()
  expect(send).toHaveBeenCalledTimes(5)
})

it('rechecks setting and cancellation under acceptance and reads unloaded journals without opening them', async () => {
  const { current, sweep, resetsAt } = await setup()
  const sessions = current.host.collaboratorsForTests().sessions
  const held = sessions.get(SESSION)!
  sessions.delete(SESSION)
  current.clock.now = resetsAt + 15_000
  const send = vi.spyOn(current.host, 'send').mockImplementation(async (_caller, params) => {
    enabled = false
    expect(() => params.beforeRun?.()).toThrow('agent_session_restart_work_superseded')
    return {
      ok: false,
      refusal: refuse('agent_session_operation_invalid', { reason: 'continuationSuperseded' })
    }
  })
  await sweep.tick()
  expect(send).toHaveBeenCalledOnce()
  expect(sessions.has(SESSION)).toBe(false)
  sessions.set(SESSION, held)
})

it('lets later due chats run while an earlier chat has an edited queued message, then retries it', async () => {
  const { current, sweep, journal, resetsAt } = await setup()
  const other = 'later-limited-chat'
  current.adapter.acquire.mockImplementationOnce(async ({ fence, spawnToken }) => ({
    acquisitionGeneration: 'later-generation',
    process: { hostId: 'local', pid: 4243, processStartTimeMs: 1_700_000_000_000, spawnToken },
    link: {
      linkId: 'later-link',
      handle: codexProviderHandle('later-thread'),
      origin: 'created',
      mintedAtFence: fence,
      observedAt: current.clock.now
    }
  }))
  const attached = await current.host.attach(
    REST_TEST_CALLER,
    hostTestAttachParams(null, {
      envelope: { ...hostTestAttachParams(null).envelope, sessionId: other },
      providerHandle: { kind: 'codex', threadId: 'later-thread' }
    })
  )
  expect(attached.ok).toBe(true)
  await current.host.setSessionTabVisibility(other, true)
  const otherJournal = current.host.collaboratorsForTests().sessions.get(other)!.journal
  await limitTurn(otherJournal, resetsAt + 1, current.clock.now)
  const release = holdLane(current.host, SESSION)
  const body = {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text: 'backlog' }]
  }
  const row = await journal.queuedMessages.insert({
    messageId: hostTestOperationId(),
    body,
    fingerprint: agentSessionSendBodyFingerprint(SESSION, body),
    hostInstance: structuredAgentSessionHostInstance()
  })
  journal.queuedMessages.editLeases.acquire(
    { callerKey: REST_TEST_CALLER.callerKey, editId: 'held-edit' },
    { messageId: row.messageId, fingerprint: row.fingerprint }
  )
  release()
  const send = vi.spyOn(current.host, 'send')
  current.clock.now = resetsAt + 15_001
  await sweep.tick()
  expect(await send.mock.results[0]!.value).toMatchObject({
    ok: false,
    refusal: { details: { reason: 'continuationSuperseded' } }
  })
  await sweep.tick()
  expect(send.mock.calls.map((call) => call[1].envelope.sessionId)).toEqual([SESSION, other])
  current.clock.now += 60_000
  await sweep.tick()
  expect(send.mock.calls.at(-1)?.[1].envelope.sessionId).toBe(SESSION)
  expect(sweep.readState(SESSION)?.state).toBe('scheduled')
})

it('reuses the status projection and does not cold replay disabled sweeps', async () => {
  const { current, sweep, journal } = await setup()
  const snapshot = vi.spyOn(journal, 'snapshot')
  sweep.readState(SESSION)
  sweep.readState(SESSION)
  expect(snapshot).not.toHaveBeenCalled()
  current.host.publishWorkChanged(SESSION)
  expect(snapshot).toHaveBeenCalledOnce()
  sweep.readState(SESSION)
  expect(snapshot).toHaveBeenCalledOnce()
  const sessions = current.host.collaboratorsForTests().sessions
  const held = sessions.get(SESSION)!
  sessions.delete(SESSION)
  enabled = false
  await sweep.tick()
  enabled = true
  // A disabled pass did not populate even the side-effect-free cold cache.
  expect(sweep.readState(SESSION)).toBeUndefined()
  sessions.set(SESSION, held)
})

it('republishes eligibility on tab restore and workspace wake', async () => {
  const { current, sweep } = await setup()
  await current.host.setSessionTabVisibility(SESSION, false)
  expect(current.host.readStatusSummary(SESSION)?.usageLimitContinue?.state).toBe('off')
  await current.host.setSessionTabVisibility(SESSION, true)
  expect(current.host.readStatusSummary(SESSION)?.usageLimitContinue?.state).toBe('scheduled')
  asleep = true
  await sweep.tick()
  expect(current.host.readStatusSummary(SESSION)?.usageLimitContinue?.state).toBe('off')
  asleep = false
  await sweep.tick()
  expect(current.host.readStatusSummary(SESSION)?.usageLimitContinue?.state).toBe('scheduled')
})

it('an ordinary Stop cancels the cut durably; late named Stop and manual Continue keep their meanings', async () => {
  const { current, sweep, turnItemId, resetsAt } = await setup()
  const stop = (turnId?: string) => {
    const fields = turnId === undefined ? {} : { turnId }
    return current.host.cancel(REST_TEST_CALLER, {
      ...fields,
      envelope: {
        sessionId: SESSION,
        expectedRuntimeFence: 1,
        clientOperationId: hostTestOperationId(),
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.cancel',
          sessionId: SESSION,
          fields
        })
      }
    })
  }
  expect(await stop('turn-1')).toMatchObject({ ok: true, value: { cancelled: false } })
  expect(sweep.readState(SESSION)?.state).toBe('scheduled')
  vi.spyOn(current.store, 'cancelUsageLimitContinue').mockRejectedValue(
    new Error('optional cancel unavailable')
  )
  expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })
  expect(current.store.getRecord(SESSION)?.usageLimitContinueCancel).toEqual({
    turnItemId,
    resetsAt
  })
  await current.restart()
  current.clock.now = resetsAt + 15_000
  const send = vi.spyOn(current.host, 'send')
  await current.host.usageLimitContinue.tick()
  expect(send).not.toHaveBeenCalled()
  const { structuredAgentSessionMessageSendMutation } =
    await import('../../../shared/structured-agent-session-send-mutation')
  const continued = await current.host.send(
    REST_TEST_CALLER,
    structuredAgentSessionMessageSendMutation({
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: current.store.getRecord(SESSION)!.lease.runtimeFence,
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE }]
      },
      usageLimitContinuationOfTurnItemId: turnItemId
    })
  )
  expect(continued.ok).toBe(true)
})

it('omits automatic scheduling presentation when the reported reset is stale', async () => {
  const { sweep } = await setup(true)
  expect(sweep.readState(SESSION)).toBeUndefined()
})
