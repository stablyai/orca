import { describe, expect, it } from 'vitest'
import { MobileTailnetEndpointSchema } from '../../../../../../shared/remote-runtime/pairing/mobile-tailnet-endpoint'
import { selectAuthenticatedMobileTailnetEndpoint } from './mobile-tailnet-fallback'

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
