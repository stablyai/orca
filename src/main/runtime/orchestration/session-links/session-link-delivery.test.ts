import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../db'
import { SessionLinkParticipant } from '../../../../shared/session-link'
import { SessionLinkStore } from './session-link-store'
import { redriveSessionLinks } from './session-link-delivery'
import { stopSessionLinkTurns } from './session-link-stop'
import { sessionLinkMessageBody } from './session-link-message'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  attach,
  hostTestState,
  seedApproval
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  hostTestSendParams,
  HOST_TEST_SESSION as SESSION
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'

vi.mock('../../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
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

  async function providerTurn(state: 'running' | 'completed', operationId = 'human-input') {
    const events = hostTestState().acquire.mock.calls.at(-1)?.[0].events
    if (!events) {
      throw new Error('Missing provider event channel')
    }
    events.appendItem(
      {
        provider: 'codex',
        threadId: '019fd532-7c11-7a90-b6de-4e1a2c3d5f60',
        turnId: 'turn-1',
        ordinal: 100
      },
      {
        kind: 'turn',
        turnId: 'turn-1',
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
})
