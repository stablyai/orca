// @vitest-environment happy-dom
import { createMobileCommandMenuHostFixture } from './mobile-queued-edit-host.test-fixture'

import { expect, it, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../../../shared/agent-session/agent-session-wire'

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
      await vi.waitFor(() =>
        expect(frames.some((event) => event.type !== 'end' && event.commandsChanged)).toBe(true)
      )
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
