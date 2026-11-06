import { expect, it, vi } from 'vitest'
import { claudeProviderHandle } from '../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalItemKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentSessionStatusEvent } from '../../../../../shared/agent-session/agent-session-wire'
import { openTestAgentSessionRecordStore } from '../../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import {
  adapterFor,
  claudeFrame,
  fakeClaude,
  identityFor
} from '../../../../claude/structured/claude-structured-session-test-support'
import { StructuredAgentSessionHost } from '../structured-agent-session-host'
import {
  attachParams,
  CALLER,
  envelope,
  hostTestState,
  replaceHostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage
} from './structured-agent-session-host-test-data'

it.each(['selected-plan', 'absent'] as const)(
  'carries %s plan answers through native fresh sends and a host restart',
  async (initial) => {
    let { host, store } = hostTestState()
    const { root, acquire, dispatch } = hostTestState()
    const acquireImpl = acquire.getMockImplementation()!
    acquire.mockImplementation(async (input) => {
      const value = await acquireImpl(input)
      return { ...value, link: { ...value.link!, handle: claudeProviderHandle(THREAD, null) } }
    })
    const claudeAttach = {
      provider: 'claude',
      agent: 'claude',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/test-claude' },
      providerHandle: { kind: 'claude', sessionId: THREAD, leafUuid: null }
    } as const
    expect(await host.attach(CALLER, attachParams(claudeAttach))).toMatchObject({ ok: true })
    const events: AgentSessionStatusEvent[] = []
    const subscribe = () =>
      host.subscribeStatus({ id: 'plan-feedback', emit: (event) => events.push(event) })
    subscribe()
    const cli = fakeClaude({
      initSessionId: THREAD,
      initPermissionMode: 'acceptEdits',
      replayUuids: ['feedback-1', 'feedback-2', 'feedback-3']
    })
    let native = adapterFor(cli, { providerSessionId: THREAD })
    const startNative = async () =>
      native.acquire({
        identity: identityFor(SESSION),
        fence: store.getRecord(SESSION)!.lease.runtimeFence,
        spawnToken: 'feedback',
        events: acquire.mock.calls.at(-1)![0].events
      })
    await startNative()
    let connection = cli.connections.at(-1)!
    const modeRequests = () =>
      connection.calls
        .filter((call) => call.subtype === 'set_permission_mode')
        .map((call) => call.params?.mode)
    dispatch.mockImplementation((input) => native.dispatch(input))
    const pick = async (value: 'plan' | 'default') => {
      const fields = { key: 'interactionMode', value }
      expect(
        await host.setOption(CALLER, {
          envelope: envelope('agentSession.setOption', fields),
          ...fields
        })
      ).toMatchObject({ ok: true })
    }
    let ordinal = 0
    const answerPlan = async (optionId: 'allow' | 'deny') => {
      const identity = { provider: 'orca' as const, clientMessageId: `plan-${ordinal++}` }
      acquire.mock.calls.at(-1)![0].events!.appendItem(
        identity,
        {
          kind: 'approval',
          title: 'Plan',
          detail: null,
          subject: { kind: 'plan', text: 'Plan' },
          options: [
            { id: 'allow', label: 'Allow' },
            { id: 'deny', label: 'Keep planning' }
          ],
          resolution: {
            state: 'pending',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      await host.flushStreamedEvents(SESSION)
      const page = await host.history({ sessionId: SESSION, direction: 'tail' })
      const prompt = page.ok
        ? page.page.items.find((item) => item.itemId === agentJournalItemKey(identity))
        : undefined
      if (!prompt) {
        throw new Error('Missing plan approval')
      }
      const fields = { itemId: prompt.itemId, expectedRevision: prompt.revision, optionId }
      expect(
        await host.respondToPrompt(CALLER, {
          envelope: envelope('agentSession.respondTo:approval', fields),
          kind: 'approval',
          ...fields
        })
      ).toMatchObject({ ok: true })
    }
    const send = async (text: string) => {
      const before = dispatch.mock.calls.length
      const body = hostTestMessage(text)
      expect(
        await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
      ).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(dispatch.mock.calls.length).toBe(before + 1))
      await dispatch.mock.results[before]!.value
      await host.collaboratorsForTests().conversationDelivery.loop.wake(SESSION)
      claudeFrame(connection, {
        session_id: THREAD,
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle'
      })
      await native.readOptions({
        sessionId: SESSION,
        fence: store.getRecord(SESSION)!.lease.runtimeFence
      })
      await host.flushStreamedEvents(SESSION)
    }
    try {
      if (initial === 'selected-plan') {
        await pick('plan')
        await answerPlan('allow')
        expect(store.getRecord(SESSION)?.options?.interactionMode).toBe('default')
      }
      claudeFrame(connection, {
        session_id: THREAD,
        type: 'system',
        subtype: 'status',
        permissionMode: 'plan'
      })
      expect(store.getRecord(SESSION)?.options?.interactionMode).toBe(
        initial === 'absent' ? undefined : 'default'
      )
      await answerPlan('deny')
      await vi.waitFor(() =>
        expect(events.at(-1)).toMatchObject({
          type: 'status',
          session: { interactionMode: 'plan' }
        })
      )
      await send('Revise the plan')
      expect(modeRequests()).toEqual(['plan'])
      expect(dispatch.mock.calls.at(-1)?.[0].executionOptions?.interactionMode).toBe('plan')
      await host.flushAllStreamedEvents()
      await native.closeAll()
      store = await openTestAgentSessionRecordStore(root)
      expect(store.getRecord(SESSION)?.options?.interactionMode).toBe('plan')
      host = new StructuredAgentSessionHost({ ...host.deps, store })
      replaceHostTestState({ host, store })
      expect(
        await host.attach(
          CALLER,
          hostTestAttachParams(store.getRecord(SESSION)!.lease.runtimeFence, claudeAttach)
        )
      ).toMatchObject({ ok: true })
      subscribe()
      native = adapterFor(cli, { providerSessionId: THREAD })
      await startNative()
      connection = cli.connections.at(-1)!
      await send('More planning feedback after restart')
      expect(modeRequests()).toEqual(['plan'])
      await pick('default')
      await vi.waitFor(() =>
        expect(events.at(-1)).toMatchObject({
          type: 'status',
          session: { interactionMode: 'default' }
        })
      )
      await send('Implement the plan')
      expect(modeRequests()).toEqual(['plan', 'acceptEdits'])
    } finally {
      await native.closeAll()
    }
  }
)
