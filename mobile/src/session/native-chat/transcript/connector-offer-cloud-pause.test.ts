import { describe, expect, it } from 'vitest'
import { connectorOfferCloudPaused } from './connector-offer-cloud-pause'

describe('connector offer while the host is signed out', () => {
  it('pauses a connected card only for the host that is signed out', () => {
    expect(connectorOfferCloudPaused('github', 'signed-out')).toBe(true)
    expect(connectorOfferCloudPaused('slack', 'ok')).toBe(false)
    expect(connectorOfferCloudPaused('linear', undefined)).toBe(false)
    expect(connectorOfferCloudPaused('google', 'signed-out')).toBe(false)
    expect(connectorOfferCloudPaused('github', 'needs-sign-in')).toBe(false)
  })
})
