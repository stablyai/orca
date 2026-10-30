import { afterEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_NOW as NOW,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import {
  TRANSIENT_RECOVERY_MESSAGE,
  wireTransientRecovery
} from './structured-agent-session-transient-recovery-wiring'

afterEach(() => vi.useRealTimers())

it('unsubscribes its completion listener exactly once on disposal', () => {
  const { host } = hostTestState()
  const subscribe = host.subscribeTurnCompletions.bind(host)
  const stopped = vi.fn()
  const spy = vi.spyOn(host, 'subscribeTurnCompletions').mockImplementation((subscriber) => {
    const unsubscribe = subscribe(subscriber)
    return () => {
      unsubscribe()
      stopped()
    }
  })
  try {
    const recovery = wireTransientRecovery(host, host.collaboratorsForTests().sessions)
    recovery.dispose()
    recovery.dispose()
    expect(stopped).toHaveBeenCalledOnce()
  } finally {
    spy.mockRestore()
  }
})

async function failTurn(error = 'serverOverloaded', message = 'Provider unavailable') {
  const { host, store } = hostTestState()
  const session = host.collaboratorsForTests().sessions.get(SESSION)!
  const fence = store.getRecord(SESSION)!.lease.runtimeFence
  const identity = { provider: 'orca' as const, clientMessageId: 'test-turn' }
  const turn = {
    kind: 'turn' as const,
    turnId: 'test-turn',
    providerTurnId: 'native-turn',
    startedAt: NOW
  }
  await session.journal.appendItem(
    identity,
    { ...turn, state: 'running' },
    { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  const head = JSON.stringify({
    turnId: 'native-turn',
    willRetry: false,
    error: { message, codexErrorInfo: error }
  })
  await session.journal.appendItem(
    { provider: 'orca', clientMessageId: 'native-error' },
    {
      kind: 'status',
      text: 'Provider unavailable',
      providerFrame: {
        provider: 'codex',
        kind: 'notification:error',
        payload: { head, byteLength: head.length, digest: 'digest', truncated: false }
      }
    },
    { fence, turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(identity) } }
  )
  await session.journal.appendItem(
    identity,
    { ...turn, state: 'completed', outcome: 'failure', completedAt: NOW + 1 },
    { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await host.flushStreamedEvents(SESSION)
}

it.each([
  ['serverOverloaded', 'Provider unavailable'],
  ['other', 'stream disconnected before completion: stream closed before response.completed']
])(
  'continues a native %s failure through the real host sender without any renderer',
  async (error, message) => {
    await attach()
    const { host, dispatch } = hostTestState()
    host.deps.transientRecovery = { enabled: () => true }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await failTurn(error, message)
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
    expect(dispatch.mock.calls[0]![0].body.blocks).toEqual([
      { type: 'text', text: TRANSIENT_RECOVERY_MESSAGE }
    ])
    expect(dispatch.mock.calls[0]![0].sessionId).toBe(SESSION)
  }
)

it('continues with the failed send options instead of the saved session model', async () => {
  await attach()
  const { host, store, dispatch } = hostTestState()
  host.deps.transientRecovery = { enabled: () => true }
  const saved = { key: 'model', value: 'saved-model' }
  await host.setOption(CALLER, {
    ...saved,
    envelope: envelope('agentSession.setOption', saved)
  })
  const body = hostTestMessage('Use the model selected for this message')
  const options = { model: 'pending-model', effort: 'high' }
  const sent = await host.send(CALLER, {
    body,
    options,
    envelope: envelope('agentSession.send', { body, options })
  })
  expect(sent.ok).toBe(true)
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
  expect(store.getRecord(SESSION)?.options?.model).not.toBe(options.model)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await failTurn()
  await vi.advanceTimersByTimeAsync(10_000)
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2))
  expect(dispatch.mock.calls[1]![0].executionOptions).toEqual(options)
  expect((await host.journalSnapshot(SESSION)).submissions.at(-1)?.options).toEqual(options)
})

it.each(['disabled', 'manual-send', 'stop', 'close', 'quota', 'dispatch-owned', 'option', 'goal'])(
  'does not auto-send after %s',
  async (action) => {
    await attach()
    const { host, dispatch } = hostTestState()
    host.deps.transientRecovery = { enabled: () => action !== 'disabled' }
    if (action === 'dispatch-owned') {
      host.deps.hasOpenDispatch = () => true
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await failTurn(action === 'quota' ? 'usageLimitExceeded' : 'serverOverloaded')
    if (action === 'manual-send') {
      const body = hostTestMessage('My next request')
      await host.send(CALLER, { body, envelope: envelope('agentSession.send', { body }) })
    }
    if (action === 'stop') {
      await host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })
    }
    if (action === 'close') {
      await host.close(SESSION, 'user-close')
    }
    if (action === 'option') {
      const fields = { key: 'model', value: 'another-model' }
      await host.setOption(CALLER, {
        envelope: envelope('agentSession.setOption', fields),
        ...fields
      })
    }
    if (action === 'goal') {
      const change = { kind: 'clear' as const }
      await host.changeThreadGoal(CALLER, {
        envelope: envelope('agentSession.threadGoal', { change }),
        change
      })
    }
    await vi.advanceTimersByTimeAsync(10_000)
    expect(dispatch).toHaveBeenCalledTimes(action === 'manual-send' ? 1 : 0)
    expect(dispatch.mock.calls.flatMap(([input]) => input.body.blocks)).not.toContainEqual({
      type: 'text',
      text: TRANSIENT_RECOVERY_MESSAGE
    })
  }
)
