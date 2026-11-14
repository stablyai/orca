import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { expect, it, vi } from 'vitest'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import {
  attach,
  hostTestState,
  seedApproval,
  CALLER,
  envelope
} from './structured-agent-session-host-test-harness'

it('omits an unproven workspace child from the stop receipt', async () => {
  const { host, store } = hostTestState()
  await attach()
  host.deps.adapter.closeSession = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)

  expect(await host.sleepWorkspace('workspace-1', true)).toEqual({
    stoppedSessionIds: [],
    failures: [{ sessionId: SESSION, reason: 'stop-unverifiable' }]
  })
  expect(store.getRecord(SESSION)).not.toBeNull()
  expect(store.getRecord(SESSION)?.sleptAt).toBeUndefined()
})

// Startup runs outside serialization; Sleep must reach it through its abort.

it.each(['fallback', 'provider-tail'] as const)(
  'sleeps quietly with pending attention and queued work through %s',
  async (ending) => {
    await attach()
    const { host, acquire } = hostTestState()
    const prompt = await seedApproval()
    const events = acquire.mock.calls[0]?.[0].events
    if (!events) {
      throw new Error('missing provider events')
    }
    const turn = { provider: 'codex' as const, threadId: THREAD, turnId: 'sleep-turn', ordinal: 1 }
    events.appendItem(
      turn,
      { kind: 'turn', turnId: 'sleep-turn', state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await host.flushStreamedEvents(SESSION)
    const body = hostTestMessage('Keep this queued message')
    const fields = { body, delivery: 'queue-if-active' as const }
    expect(
      await host.send(CALLER, {
        ...fields,
        userSend: true,
        envelope: envelope('agentSession.send', fields)
      })
    ).toMatchObject({ ok: true })
    host.deps.adapter.closeSession = async () => {
      if (ending === 'provider-tail') {
        events.appendItem(
          turn,
          { kind: 'turn', turnId: 'sleep-turn', state: 'interrupted' },
          { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
      }
      return true
    }
    expect(await host.sleepWorkspace('workspace-1', true)).toEqual({
      stoppedSessionIds: [SESSION]
    })
    const page = await host.history({ sessionId: SESSION, direction: 'tail' })
    if (!page.ok) {
      throw new Error('history refused')
    }
    expect(page.page.actionablePromptIds).toEqual([prompt.itemId])
    expect(
      page.page.items.find((item) => item.body.kind === 'turn' && item.body.turnId === 'sleep-turn')
        ?.body
    ).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
    expect(
      page.page.items.filter((item) => item.body.kind === 'status' && item.body.tone === 'error')
    ).toEqual([])
    expect(host.loadedSessionIds()).toEqual([])
    expect(page.page.queuedMessages).toContainEqual(expect.objectContaining({ body }))
  }
)
