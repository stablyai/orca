import { describe, expect, it, vi } from 'vitest'

const platform = vi.hoisted((): { OS: string } => ({ OS: 'ios' }))
vi.mock('react-native', () => ({ Platform: platform }))

import {
  hostHasIrohEndpoint,
  inferIrohPathMode,
  isIrohNativePlatform
} from './mobile-iroh-availability'
import type { HostProfile } from './types'

const host = (opts?: {
  iroh?: { endpointId: string }
  relay?: HostProfile['relay']
}): HostProfile => ({
  id: 'h1',
  name: 'Host',
  endpoint: 'ws://127.0.0.1:6768',
  deviceToken: 'tok',
  publicKeyB64: 'key',
  lastConnected: 0,
  ...(opts?.iroh ? { iroh: opts.iroh } : {}),
  ...(opts?.relay ? { relay: opts.relay } : {})
})

const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-c1.onorca.dev',
  assignmentEpoch: 1,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2 as const
}

describe('mobile iroh availability', () => {
  it('accepts only 64-char hex endpoint ids', () => {
    expect(hostHasIrohEndpoint(host({ iroh: { endpointId: 'a'.repeat(64) } }))).toBe(true)
    expect(hostHasIrohEndpoint(host({ iroh: { endpointId: 'not-hex' } }))).toBe(false)
    expect(hostHasIrohEndpoint(host())).toBe(false)
  })

  it('infers primary-off-lan when iroh present without relay', () => {
    expect(inferIrohPathMode(host({ iroh: { endpointId: 'a'.repeat(64) } }))).toBe(
      'primary-off-lan'
    )
    expect(inferIrohPathMode(host({ iroh: { endpointId: 'a'.repeat(64) }, relay }))).toBe(
      'fallback'
    )
    expect(inferIrohPathMode(host())).toBe('off')
  })

  it('treats iOS and Android as iroh-native platforms', () => {
    for (const [os, native] of [
      ['ios', true],
      ['android', true],
      ['web', false]
    ] as const) {
      platform.OS = os
      expect(isIrohNativePlatform()).toBe(native)
    }
  })
})
