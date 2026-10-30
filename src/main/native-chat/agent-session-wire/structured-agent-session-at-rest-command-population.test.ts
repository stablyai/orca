// @vitest-environment happy-dom
import { createMobileCommandMenuHostFixture } from './mobile-queued-edit-host.test-fixture'
import { AGENT_SESSION_COMMANDS_ON_REQUEST_CAPABILITY } from '../../../shared/structured-agent-session-surface-capabilities'
import { expect, it, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'

it.each([
  ['claude', false],
  ['omp', false],
  ['claude', true]
] as const)(
  'uses the phone CI host fixture with actual %s dispatch, pending preparation=%s and retirement',
  async (provider, pending) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const fixture = await createMobileCommandMenuHostFixture(provider, pending)
    const frames: AgentSessionSubscribeEvent[] = []
    const stop = await fixture.subscribe((event) => frames.push(event))
    try {
      expect(fixture.starts()).toBe(0)
      if (pending) {
        const read = fixture.read()
        await vi.advanceTimersByTimeAsync(10_000)
        expect(await read).toMatchObject({ commandsPending: true })
        await vi.advanceTimersByTimeAsync(330_000)
        expect(fixture.starts()).toBe(0)
      } else {
        expect((await fixture.read()).commands?.some((row) => row.name === 'fast')).toBe(true)
      }
      await fixture.retire(true)
      expect(frames.some((event) => event.type !== 'end' && event.commandsChanged)).toBe(true)
      expect(fixture.starts()).toBe(pending ? 0 : 1)
      expect((await fixture.read()).commands?.some((row) => row.name === 'fast')).toBe(true)
      expect(fixture.starts()).toBe(pending ? 1 : 2)
    } finally {
      stop()
      await fixture.dispose()
      vi.useRealTimers()
    }
  }
)

it.each(['claude', 'omp'] as const)(
  'keeps marked pre-report phone requests independent, sharing each %s context at N/10N',
  async (provider) => {
    for (const count of [3, 30]) {
      const host = await createMobileCommandMenuHostFixture(provider, true, count)
      try {
        const reads = host.sessionIds.map((id) =>
          host.request(id, [AGENT_SESSION_COMMANDS_ON_REQUEST_CAPABILITY])
        )
        const joined = host.request(host.sessionId, [AGENT_SESSION_COMMANDS_ON_REQUEST_CAPABILITY])
        for (const id of host.sessionIds) {
          expect(host.pending(id)).toBe(true)
        }
        await vi.waitFor(() => expect(host.preparations()).toBe(count))
        expect(host.starts()).toBe(0)
        host.releasePreparation()
        const replies = await Promise.all([...reads, joined])
        expect(replies.every((reply) => reply.commands?.some((row) => row.name === 'fast'))).toBe(
          true
        )
        expect(host.starts()).toBe(count)
        expect(host.preparations()).toBe(count)
        for (const id of host.sessionIds) {
          expect(host.pending(id)).toBe(false)
        }
      } finally {
        await host.dispose()
      }
    }
  }
)
