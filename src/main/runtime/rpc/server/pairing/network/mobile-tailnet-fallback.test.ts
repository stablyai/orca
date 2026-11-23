import { describe, expect, it } from 'vitest'
import { MobileLanEndpointSchema } from '../../../../../../shared/remote-runtime/pairing/mobile-lan-endpoint'
import { MobileTailnetEndpointSchema } from '../../../../../../shared/remote-runtime/pairing/mobile-tailnet-endpoint'
import {
  selectAuthenticatedMobileLanEndpoint,
  selectAuthenticatedMobileTailnetEndpoint
} from './mobile-tailnet-fallback'

describe('authenticated mobile Tailscale endpoint discovery', () => {
  const lan = { name: 'en0', address: '192.168.50.131' }
  const tailnet = { name: 'utun5', address: '100.120.233.23' }

  it('advertises only a non-virtual tailnet address on the serving port', () => {
    expect(selectAuthenticatedMobileTailnetEndpoint([lan, tailnet], 6768)).toBe(
      'ws://100.120.233.23:6768/'
    )
    expect(
      selectAuthenticatedMobileTailnetEndpoint(
        [lan, { name: 'docker0', address: '100.120.233.23' }],
        6768
      )
    ).toBeUndefined()
    expect(selectAuthenticatedMobileTailnetEndpoint([lan, tailnet], 0)).toBeUndefined()
    expect(selectAuthenticatedMobileTailnetEndpoint([lan], 6768)).toBeUndefined()
  })

  it('advertises nothing when two distinct tailnet-range addresses are present', () => {
    expect(
      selectAuthenticatedMobileTailnetEndpoint(
        [tailnet, { name: 'utun9', address: '100.100.1.2' }],
        6768
      )
    ).toBeUndefined()
  })

  it('accepts an explicit default port', () => {
    expect(MobileTailnetEndpointSchema.safeParse('ws://100.120.233.23:80/').success).toBe(true)
    expect(MobileTailnetEndpointSchema.safeParse('ws://192.168.1.2:80/').success).toBe(false)
  })
})

describe('authenticated mobile LAN endpoint discovery', () => {
  it('advertises a unique reachable private LAN route with the live WebSocket port', () => {
    expect(
      selectAuthenticatedMobileLanEndpoint(
        [
          { name: 'en0', address: '192.168.50.131' },
          { name: 'utun5', address: '100.120.233.23' },
          { name: 'docker0', address: '172.17.0.1' }
        ],
        6768
      )
    ).toBe('ws://192.168.50.131:6768/')
  })

  it('does not guess which of multiple LAN interfaces a phone can reach', () => {
    expect(
      selectAuthenticatedMobileLanEndpoint(
        [
          { name: 'en0', address: '192.168.50.131' },
          { name: 'en8', address: '10.10.0.5' }
        ],
        6768
      )
    ).toBeUndefined()
  })

  it('rejects non-private and malformed LAN WebSocket addresses', () => {
    expect(MobileLanEndpointSchema.safeParse('ws://192.168.50.131:6768/').success).toBe(true)
    expect(MobileLanEndpointSchema.safeParse('ws://100.120.233.23:6768/').success).toBe(false)
    expect(MobileLanEndpointSchema.safeParse('ws://8.8.8.8:6768/').success).toBe(false)
    expect(MobileLanEndpointSchema.safeParse('ws://10.999.1.1:6768/').success).toBe(false)
  })
})
