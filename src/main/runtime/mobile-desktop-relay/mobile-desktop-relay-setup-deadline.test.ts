// #36923: after a held open, the relay has one deadline for grant sync and the socket together,
// so a phone's open is answered before the phone gives up.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { relaySetupDeadline } from './mobile-desktop-relay-link'

describe('a relay link setup deadline', () => {
  afterEach(() => vi.useRealTimers())

  it('spends one budget across steps and refuses a step that outlasts it', async () => {
    vi.useFakeTimers()
    const setup = relaySetupDeadline(15_000)
    const sync = setup.within(new Promise(() => {}))
    const refused = expect(sync).rejects.toMatchObject({ code: 'remote_runtime_unavailable' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(setup.remaining()).toBe(5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    await refused
    expect(setup.remaining()).toBe(0)
  })

  it('passes through a step that finishes in time', async () => {
    const setup = relaySetupDeadline(15_000)
    await expect(setup.within(Promise.resolve('grants'))).resolves.toBe('grants')
  })
})
