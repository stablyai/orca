import { resolveUnknownSessionLinkDelivery } from './session-link-resolution'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../db/orchestration-db'
import { SessionLinkParticipant } from '../../../../shared/session-link'
import { SessionLinkStore } from './session-link-store'
import { redriveSessionLinks } from './session-link-delivery'
import { stopSessionLinkTurns } from './session-link-stop'
import { sessionLinkMessageBody } from './session-link-message'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  attach,
  hostTestState,
  seedApproval
} from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-harness'
import {
  hostTestSendParams,
  HOST_TEST_SESSION as SESSION
} from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data'

vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: vi.fn()
}))

describe('session link delivery through the real structured host', () => {
  let db: OrchestrationDb
  let store: SessionLinkStore
  beforeEach(async () => {
    const { host } = hostTestState()
    vi.mocked(getStructuredAgentSessionHost).mockReturnValue(host)
    await attach()
    await host.deps.store.setSessionTabVisibility(SESSION, true, 'tab-link')
    db = new OrchestrationDb(':memory:')
    store = new SessionLinkStore(db)
    store.create('link-test', 'Slice 1b', [
      SessionLinkParticipant.parse({
        sessionId: 'reviewer',
        conversationId: 'reviewer',
        name: 'Claude review',
        agent: 'claude',
        role: 'reviewer',
        workspaceId: 'workspace-review',
        directory: '/work/review',
        branch: 'design',
        task: 'Review',
        context: ''
      }),
      SessionLinkParticipant.parse({
        sessionId: SESSION,
        conversationId: SESSION,
        name: 'Codex implement',
        agent: 'codex',
        role: 'implementer',
        workspaceId: 'workspace-1',
        directory: '/work/implement',
        branch: 'feature',
        task: 'Implement',
        context: ''
      })
    ])
  })
  afterEach(() => db.close())
  const message = () =>
    store.append({
      id: 'report',
      linkId: 'link-test',
      actor: 'reviewer',
      recipient: SESSION,
      kind: 'message',
      body: 'Review complete; local checks only.'
    })

  async function providerTurn(
    state: 'running' | 'completed',
    operationId = 'human-input',
    turnId = 'turn-1'
  ) {
    const events = hostTestState().acquire.mock.calls.at(-1)?.[0].events
    if (!events) {
      throw new Error('Missing provider event channel')
    }
    events.appendItem(
      {
        provider: 'codex',
        threadId: '019fd532-7c11-7a90-b6de-4e1a2c3d5f60',
        turnId,
        ordinal: 100
      },
      {
        kind: 'turn',
        turnId,
        state,
        startedAt: 1,
        userItemId: agentJournalSubmissionKey(operationId)
      },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await hostTestState().host.flushStreamedEvents(SESSION)
  }

  it('waits for a busy turn to finish, then wakes the chat instead of steering its running turn', async () => {
    const { dispatch } = hostTestState()
    await providerTurn('running')
    message()
    await redriveSessionLinks(db, SESSION)
    expect(dispatch).not.toHaveBeenCalled()
    expect(store.event('report')?.state).toBe('queued')
    await providerTurn('completed')
    await redriveSessionLinks(db, SESSION)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(store.event('report')?.state).toBe('accepted')
  })

  it('wakes an idle chat with typed peer provenance, once, and does not touch an empty partner journal', async () => {
    const { host, dispatch } = hostTestState()
    const read = vi.spyOn(host, 'journalSnapshot')
    await redriveSessionLinks(db, SESSION)
    expect(read).not.toHaveBeenCalled()
    const event = message()
    await redriveSessionLinks(db, SESSION)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(store.event(event.id)).toMatchObject({
      state: 'accepted',
      operationId: event.operationId
    })
    expect(dispatch.mock.calls[0][0].body.from).toMatchObject({
      kind: 'agent',
      link: { id: 'link-test', eventId: event.id }
    })
    await redriveSessionLinks(db, SESSION)
    expect(dispatch).toHaveBeenCalledOnce()
  })

  it('holds mail behind a human approval without consuming it or starting a turn', async () => {
    const { dispatch } = hostTestState()
    await seedApproval()
    message()
    await redriveSessionLinks(db, SESSION)
    expect(dispatch).not.toHaveBeenCalled()
    expect(store.event('report')?.state).toBe('queued')
    expect(store.get('link-test').turns).toBe(0)
  })

  it('rechecks pause under host serialization immediately before any provider effect', async () => {
    const { host, dispatch } = hostTestState()
    const send = host.send
    vi.spyOn(host, 'send').mockImplementation(async (caller, params) => {
      store.control('link-test', 'owner', 'raced-pause', 1, 'pause')
      return send(caller, params)
    })
    message()
    await redriveSessionLinks(db, SESSION)
    expect(dispatch).not.toHaveBeenCalled()
    expect(store.event('report')).toMatchObject({ state: 'blocked', retryable: true })
    expect(store.get('link-test').state).toBe('paused')
  })

  it('never redelivers an unknown/crashed operation, even after an owner continuation', async () => {
    const { dispatch } = hostTestState()
    const event = message()
    store.reserve('link-test', event.id)
    await redriveSessionLinks(db, SESSION)
    expect(dispatch).not.toHaveBeenCalled()
    store.control('link-test', 'owner', 'pause', store.get('link-test').version, 'pause')
    store.control('link-test', 'owner', 'resume', store.get('link-test').version, 'resume')
    await redriveSessionLinks(db, SESSION)
    expect(store.event(event.id)).toMatchObject({
      state: 'blocked',
      retryable: false,
      operationId: event.operationId
    })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('keeps a closed/context-changed participant paused even when the outbox is empty', async () => {
    const { host } = hostTestState()
    vi.spyOn(host.deps.store, 'getConversation').mockReturnValue(null)
    await redriveSessionLinks(db, SESSION)
    expect(store.get('link-test')).toMatchObject({ state: 'paused', reason: 'participant-changed' })
    expect(store.events('link-test')).toContainEqual(
      expect.objectContaining({ actor: 'host', kind: 'control', detail: 'participant-changed' })
    )
  })

  it('introductions direct agents to ordinary messages; only actual peer mail can be replied to', () => {
    const event = store.append({
      id: 'intro',
      linkId: 'link-test',
      actor: 'host',
      recipient: SESSION,
      kind: 'introduction',
      body: 'Meet the reviewer.'
    })
    const body = sessionLinkMessageBody(store.get('link-test'), event)
    expect(JSON.stringify(body)).toContain('--kind message')
    expect(JSON.stringify(body)).not.toContain('--reply-to intro')
  })
  it('stops only the proved link-origin turn and persists cancellation identity before the effect', async () => {
    const { host, cancelTurn } = hostTestState()
    message()
    await redriveSessionLinks(db, SESSION)
    const event = store.event('report')
    if (!event) {
      throw new Error('Missing report')
    }
    await providerTurn('running', event.operationId)
    const cancel = host.cancel
    const calls: string[] = []
    vi.spyOn(host, 'cancel').mockImplementation(async (caller, params) => {
      calls.push(params.envelope.clientOperationId)
      expect(
        store
          .events('link-test')
          .some(
            (e) =>
              e.operationId === params.envelope.clientOperationId && e.detail === 'stop-pending'
          )
      ).toBe(true)
      if (calls.length === 1) {
        throw new Error('Crash before reply')
      }
      return cancel(caller, params)
    })
    await expect(stopSessionLinkTurns(store, 'link-test', 'urgent-stop')).rejects.toThrow('Crash')
    await stopSessionLinkTurns(store, 'link-test', 'urgent-stop')
    expect(calls[0]).toBe(calls[1])
    expect(cancelTurn).toHaveBeenCalledOnce()
  })

  it('lets only the current calling delivery finish its control reply', async () => {
    const { cancelTurn } = hostTestState()
    const current = message()
    await redriveSessionLinks(db, SESSION)
    await providerTurn('running', current.operationId)
    await stopSessionLinkTurns(store, 'link-test', 'current-control', {
      sessionId: SESSION,
      operationId: current.operationId
    })
    expect(cancelTurn).not.toHaveBeenCalled()
    expect(store.events('link-test')).toContainEqual(
      expect.objectContaining({
        targetTurnId: 'turn-1',
        detail: 'stop-calling-turn-kept'
      })
    )
    await providerTurn('completed', current.operationId)
    const next = store.append({
      id: 'after-control',
      linkId: 'link-test',
      actor: 'reviewer',
      recipient: SESSION,
      kind: 'message',
      body: 'A later owner-approved continuation.'
    })
    await redriveSessionLinks(db, SESSION)
    await providerTurn('running', next.operationId, 'turn-2')
    await stopSessionLinkTurns(store, 'link-test', 'current-control', {
      sessionId: SESSION,
      operationId: current.operationId
    })
    expect(cancelTurn).not.toHaveBeenCalled()
  })

  it('does not exempt a later link turn when an older background command stops the link', async () => {
    const { cancelTurn } = hostTestState()
    const first = message()
    await redriveSessionLinks(db, SESSION)
    await providerTurn('completed', first.operationId)
    const next = store.append({
      id: 'next-report',
      linkId: 'link-test',
      actor: 'reviewer',
      recipient: SESSION,
      kind: 'message',
      body: 'A later review report.'
    })
    await redriveSessionLinks(db, SESSION)
    await providerTurn('running', next.operationId, 'turn-2')
    await stopSessionLinkTurns(store, 'link-test', 'background-stop', {
      sessionId: SESSION,
      operationId: first.operationId
    })
    expect(cancelTurn).toHaveBeenCalledOnce()
    expect(store.events('link-test')).toContainEqual(
      expect.objectContaining({
        kind: 'control',
        recipient: SESSION,
        targetTurnId: 'turn-2',
        detail: 'stop-acknowledged'
      })
    )
  })

  it('records an already idle participant without a false unconfirmed-stop warning', async () => {
    const { cancelTurn } = hostTestState()
    message()
    await redriveSessionLinks(db, SESSION)
    await providerTurn('completed', store.event('report')?.operationId)
    await stopSessionLinkTurns(store, 'link-test', 'stop-idle')
    expect(cancelTurn).not.toHaveBeenCalled()
    expect(
      store.events('link-test').find((e) => e.kind === 'control' && e.recipient === SESSION)?.detail
    ).toBe('stop-idle')
  })

  it('does not retarget an idle stop receipt after a later continuation', async () => {
    const { cancelTurn } = hostTestState()
    await stopSessionLinkTurns(store, 'link-test', 'idle-control')
    const next = message()
    await redriveSessionLinks(db, SESSION)
    await providerTurn('running', next.operationId)
    await stopSessionLinkTurns(store, 'link-test', 'idle-control')
    expect(cancelTurn).not.toHaveBeenCalled()
    expect(store.events('link-test')).toContainEqual(
      expect.objectContaining({
        recipient: SESSION,
        detail: 'stop-idle'
      })
    )
  })

  it('retains an unconfirmed stop when the host was absent instead of targeting a future turn', async () => {
    const { host, cancelTurn } = hostTestState()
    vi.mocked(getStructuredAgentSessionHost).mockReturnValue(null)
    await stopSessionLinkTurns(store, 'link-test', 'host-absent')
    vi.mocked(getStructuredAgentSessionHost).mockReturnValue(host)
    const next = message()
    await redriveSessionLinks(db, SESSION)
    await providerTurn('running', next.operationId)
    await stopSessionLinkTurns(store, 'link-test', 'host-absent')
    expect(cancelTurn).not.toHaveBeenCalled()
    expect(store.events('link-test')).toContainEqual(
      expect.objectContaining({
        recipient: SESSION,
        detail: 'stop-unconfirmed'
      })
    )
  })

  it('keeps a stop unconfirmed while an accepted send has no provable provider turn', async () => {
    const { cancelTurn } = hostTestState()
    message()
    await redriveSessionLinks(db, SESSION)
    await stopSessionLinkTurns(store, 'link-test', 'stop-before-turn')
    expect(cancelTurn).not.toHaveBeenCalled()
    expect(store.events('link-test').find((e) => e.kind === 'control')?.detail).toBe(
      'stop-unconfirmed'
    )
  })

  it('leaves an unrelated human-triggered turn running on urgent link stop', async () => {
    const { host, cancelTurn } = hostTestState()
    await host.send({ callerKey: 'human' }, hostTestSendParams('Work on the owner task'))
    await stopSessionLinkTurns(store, 'link-test', 'stop-other')
    expect(cancelTurn).not.toHaveBeenCalled()
  })

  it('reconciles a queued card and its converted submission by the original operation without another send', async () => {
    const { host, dispatch } = hostTestState()
    const event = message()
    store.reserve('link-test', event.id)
    const answer = vi.spyOn(host, 'queuedSendAnswer').mockResolvedValue({
      clientMessageId: event.operationId,
      queued: { messageId: event.operationId, position: 1, state: 'waiting' }
    })
    await redriveSessionLinks(db, SESSION)
    expect(store.event(event.id)?.state).toBe('dispatching')
    expect(store.get('link-test').state).toBe('active')
    expect(dispatch).not.toHaveBeenCalled()
    const converted = hostTestSendParams('Review complete')
    await host.send({ callerKey: 'converted-card' }, converted)
    await host.waitForSendSettlement(SESSION, converted.envelope.clientOperationId, {
      budgetMs: 1000
    })
    const submission = (await host.journalSnapshot(SESSION)).submissions.find(
      (s) => s.clientMessageId === converted.envelope.clientOperationId
    )
    if (!submission) {
      throw new Error('Missing converted submission')
    }
    answer.mockResolvedValue({ clientMessageId: event.operationId, submission })
    await redriveSessionLinks(db, SESSION)
    await redriveSessionLinks(db, SESSION)
    expect(store.event(event.id)).toMatchObject({
      state: 'accepted',
      operationId: event.operationId
    })
    expect(dispatch).toHaveBeenCalledOnce()
  })

  it('lets the owner review an unknown send without resending it, even after a late accepted receipt', async () => {
    const { host, dispatch } = hostTestState()
    const event = message()
    store.reserve('link-test', event.id)
    await redriveSessionLinks(db, SESSION)
    const input = {
      id: 'link-test',
      eventId: event.id,
      operationId: 'review-unknown',
      version: store.get('link-test').version
    }
    resolveUnknownSessionLinkDelivery(store, input)
    resolveUnknownSessionLinkDelivery(store, input)
    expect(store.get('link-test').state).toBe('paused')
    expect(store.event(event.id)).toMatchObject({
      state: 'cancelled',
      operationId: event.operationId
    })
    expect(store.events('link-test').filter((e) => e.requestId === input.operationId)).toHaveLength(
      1
    )
    await host.send(
      { callerKey: 'late-receipt' },
      hostTestSendParams('Original delivery', event.operationId)
    )
    await host.waitForSendSettlement(SESSION, event.operationId, { budgetMs: 1000 })
    await providerTurn('completed', event.operationId)
    store.append({
      id: 'later-report',
      linkId: 'link-test',
      actor: 'reviewer',
      recipient: SESSION,
      kind: 'message',
      body: 'Later report'
    })
    store.control(
      'link-test',
      'owner',
      'resume-after-review',
      store.get('link-test').version,
      'resume'
    )
    await redriveSessionLinks(db, SESSION)
    await redriveSessionLinks(db, SESSION)
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(store.event(event.id)?.state).toBe('cancelled')
    expect(store.event('later-report')?.state).toBe('accepted')
  })
})
