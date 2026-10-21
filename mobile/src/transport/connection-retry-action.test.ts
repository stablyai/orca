import { describe, expect, it, vi } from 'vitest'
import { connectionRetryAction } from './connection-retry-action'

describe('connectionRetryAction', () => {
  it('re-reads when the host is connected, with or without a re-dial', () => {
    for (const forceReconnect of [null, vi.fn()]) {
      const reload = vi.fn()
      connectionRetryAction({ hostId: 'h', needsReconnect: false, forceReconnect, reload })?.()
      expect(reload).toHaveBeenCalledTimes(1)
    }
  })

  it('re-dials a host that needs it where this document can dial', () => {
    const forceReconnect = vi.fn()
    const reload = vi.fn()
    connectionRetryAction({ hostId: 'h', needsReconnect: true, forceReconnect, reload })?.()
    expect({ redials: forceReconnect.mock.calls, reloads: reload.mock.calls.length }).toEqual({
      redials: [['h']],
      reloads: 0
    })
  })

  it('offers nothing where a re-dial is needed and this document cannot make one', () => {
    expect(
      connectionRetryAction({
        hostId: 'h',
        needsReconnect: true,
        forceReconnect: null,
        reload: () => {}
      })
    ).toBeNull()
  })

  it('re-reads when there is no host to re-dial', () => {
    const reload = vi.fn()
    connectionRetryAction({
      hostId: undefined,
      needsReconnect: true,
      forceReconnect: null,
      reload
    })?.()
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
