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
import { TRANSIENT_RECOVERY_MESSAGE } from './structured-agent-session-transient-recovery-wiring'

afterEach(() => vi.useRealTimers())

async function failTurn(error = 'serverOverloaded') {
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
    error: { message: 'Provider unavailable', codexErrorInfo: error }
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

it('continues a native capacity failure through the real host sender without any renderer', async () => {
  await attach()
  const { host, dispatch } = hostTestState()
  host.deps.transientRecovery = { enabled: () => true }
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await failTurn()
  await vi.advanceTimersByTimeAsync(10_000)
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
  expect(dispatch.mock.calls[0]![0].body.blocks).toEqual([
    { type: 'text', text: TRANSIENT_RECOVERY_MESSAGE }
  ])
  expect(dispatch.mock.calls[0]![0].sessionId).toBe(SESSION)
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
