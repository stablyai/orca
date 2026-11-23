import { expect, it, vi } from 'vitest'
import {
  RPC_RECONNECT_ATTEMPT_LIMIT,
  RpcClientReconnectSchedule
} from './rpc-client-reconnect-schedule'

it('gives a dormant Tailscale host a separate retry on app return', () => {
  vi.useFakeTimers()
  const reconnect = new RpcClientReconnectSchedule({
    tailnetEndpoint: true,
    openConnection: () => {},
    rejectConnectWaiters: () => {},
    emitLog: () => {}
  })
  try {
    for (let attempt = 0; attempt < RPC_RECONNECT_ATTEMPT_LIMIT; attempt++) {
      reconnect.schedule()
      vi.advanceTimersToNextTimer()
    }

    reconnect.schedule()
    expect(reconnect.canRetryFromHint('network-change', 0)).toBe(false)
    expect(reconnect.canRetryFromHint('app-resume', 0)).toBe(true)
    reconnect.redialNow('app-resume', true, false)
    reconnect.schedule()

    expect(reconnect.canRetryFromHint('app-resume', 0)).toBe(false)
    expect(reconnect.canRetryFromHint('focus', 0)).toBe(true)
  } finally {
    reconnect.cancel()
    vi.useRealTimers()
  }
})
