import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { directPathForEndpoint } from './mobile-direct-endpoint-probe'

describe('mobile direct endpoint probe', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('classifies a tailnet endpoint apart from a LAN one', () => {
    expect(directPathForEndpoint('ws://100.64.0.2:6768')).toBe('tailscale')
    expect(directPathForEndpoint('wss://desk.tail1234.ts.net:6768')).toBe('tailscale')
    expect(directPathForEndpoint('ws://[fd7a:115c:a1e0::1]:6768')).toBe('tailscale')
    // 100.0.0.0/10 is not the tailnet's 100.64.0.0/10.
    expect(directPathForEndpoint('ws://100.12.0.2:6768')).toBe('lan')
    expect(directPathForEndpoint('ws://192.168.1.10:6768')).toBe('lan')
  })
})
