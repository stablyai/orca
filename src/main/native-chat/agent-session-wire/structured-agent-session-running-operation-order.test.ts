import { expect, it, vi } from 'vitest'
import {
  CALLER,
  attach,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { structuredAgentSessionCompactBody } from './structured-agent-session-command-turn'
import type { StructuredAgentSessionProviderOpenResult } from './structured-agent-session-provider-open-contract'

it.each(['goal', 'rewind'] as const)(
  'answers a %s while an earlier message is queued behind compact',
  async (operation) => {
    const { host, dispatch } = hostTestState()
    const compact = vi.fn(async () => ({ state: 'accepted' as const, providerIdentity: null }))
    host.deps.adapter.compact = compact
    host.deps.adapter.changeThreadGoal = vi.fn(async () => ({ ok: true as const }))
    host.deps.adapter.rewindSupport = () => ({ supported: true })
    await attach()
    const body = structuredAgentSessionCompactBody()
    expect(
      await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
    ).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce())
    const queued = hostTestMessage('After compact')
    expect(
      await host.send(CALLER, {
        envelope: envelope('agentSession.send', { body: queued }),
        body: queued
      })
    ).toMatchObject({ ok: true })
    const change = { kind: 'set' as const, objective: 'A goal during compact' }
    const expectedEpoch = (await host.journalSnapshot(SESSION)).cursor.epoch
    const itemId = 'codex:thread-1:turn-1:1'
    const result =
      operation === 'goal'
        ? host.changeThreadGoal(CALLER, {
            envelope: envelope('agentSession.threadGoal', { change }),
            change
          })
        : host.rewind(CALLER, {
            envelope: envelope('agentSession.rewind', { itemId, expectedEpoch }),
            itemId,
            expectedEpoch
          })
    let settled = false
    void result.then(() => {
      settled = true
    })
    await vi.waitFor(() => expect(settled).toBe(true))
    expect(await result).toMatchObject(
      operation === 'goal' ? { ok: true } : { ok: false, refusal: { rewindReason: 'busy' } }
    )
    expect(dispatch).not.toHaveBeenCalled()
    expect((await host.journalSnapshot(SESSION)).submissions.at(-1)?.dispatchState).toBe('pending')
  }
)

it('releases a startup goal when earlier delivery parks behind compact', async () => {
  const { host, dispatch } = hostTestState()
  const opened = Promise.withResolvers<StructuredAgentSessionProviderOpenResult>()
  host.deps.adapter.open = () => opened.promise
  host.deps.adapter.compact = vi.fn(async () => ({
    state: 'accepted' as const,
    providerIdentity: null
  }))
  host.deps.adapter.changeThreadGoal = vi.fn(async () => ({ ok: true as const }))
  await attach()
  for (const body of [structuredAgentSessionCompactBody(), hostTestMessage('After compact')]) {
    expect(
      await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
    ).toMatchObject({ ok: true })
  }
  const change = { kind: 'set' as const, objective: 'A goal requested during startup' }
  const result = host.changeThreadGoal(CALLER, {
    envelope: envelope('agentSession.threadGoal', { change }),
    change
  })
  await host.collaboratorsForTests().serialize(SESSION, async () => {})
  opened.resolve({ reportedOptions: { model: '' } })
  let settled = false
  void result.then(() => {
    settled = true
  })
  await vi.waitFor(() => expect(settled).toBe(true))
  expect(await result).toMatchObject({ ok: true })
  expect(dispatch).not.toHaveBeenCalled()
})
