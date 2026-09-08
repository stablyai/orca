import { describe, expect, it } from 'vitest'
import { nextMobileWebShellConnectionMetrics } from './mobile-web-shell-connection-metrics'

describe('mobile web shell connection metrics', () => {
  it('retains omitted metrics for the same shell context', () => {
    expect(
      nextMobileWebShellConnectionMetrics({ reconnectAttempts: 4, lastConnectedAt: 123 }, {}, true)
    ).toEqual({ reconnectAttempts: 4, lastConnectedAt: 123 })
  })

  it('resets omitted metrics when the shell context changes', () => {
    expect(
      nextMobileWebShellConnectionMetrics({ reconnectAttempts: 4, lastConnectedAt: 123 }, {}, false)
    ).toEqual({ reconnectAttempts: 0, lastConnectedAt: null })
  })

  it('preserves an explicit never-connected timestamp', () => {
    expect(
      nextMobileWebShellConnectionMetrics(
        { reconnectAttempts: 4, lastConnectedAt: 123 },
        { reconnectAttempts: 12, lastConnectedAt: null },
        true
      )
    ).toEqual({ reconnectAttempts: 12, lastConnectedAt: null })
  })
})
