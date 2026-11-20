import { afterEach, expect, it, vi } from 'vitest'
import { fixture, paneKey } from './agent-view-mod-fixture'

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

// #44987: idle sessions must not resend configuration; view changes must stay small.
it.each([1024, 128 * 1024])(
  'bounds idle and view-change work with %i-byte bindings',
  async (size) => {
    vi.useFakeTimers()
    const app = fixture()
    app.state.keybindings = app.state.keybindings.padEnd(size, ' ')
    await app.start()
    expect(await app.view()).toEqual({ status: 'viewed' })
    app.posts.length = 0
    for (let minute = 0; minute < 10; minute++) {
      const start = app.posts.length
      await vi.advanceTimersByTimeAsync(60_000)
      const interval = app.posts.slice(start)
      expect(interval.filter(({ action }) => action === 'register')).toHaveLength(0)
      expect(interval.filter(({ action }) => action === 'renew').length).toBeLessThanOrEqual(1)
      for (const post of interval) {
        expect(post).toEqual({
          action: 'renew',
          paneKey,
          sessionId: 'session',
          instanceId: expect.any(String)
        })
      }
    }
    const read = vi.spyOn(app.api.fs, 'read')
    app.posts.length = 0
    await app.render('child')
    expect(read.mock.calls.filter(([path]) => path.endsWith('keybindings.json'))).toHaveLength(0)
    expect(app.posts).toEqual([
      {
        action: 'observe',
        paneKey,
        sessionId: 'session',
        instanceId: expect.any(String),
        view: { agentId: 'child', revision: 2 }
      }
    ])
    expect(await app.view('child')).toEqual({ status: 'viewed' })
    app.bridge.clear()
  }
)
