import { describe, expect, it } from 'vitest'
import {
  UNKNOWN_EXTERNAL_APP_REQUEST_ORIGIN,
  originFromGuestDocument,
  originFromInitiatingFrame,
  originFromNavigationEvent
} from './external-app-request-origin'

describe('external-app-request-origin', () => {
  it('reads the initiating frame origin', () => {
    expect(originFromInitiatingFrame({ url: 'https://untrusted-frame.example/embedded' })).toBe(
      'https://untrusted-frame.example'
    )
  })

  it('does not fall back to a destination frame when initiator is missing', () => {
    expect(
      originFromNavigationEvent({
        initiator: null
      })
    ).toBe(UNKNOWN_EXTERNAL_APP_REQUEST_ORIGIN)
    expect(originFromInitiatingFrame(undefined)).toBe(UNKNOWN_EXTERNAL_APP_REQUEST_ORIGIN)
  })

  it('uses unknown when the initiating frame is gone or unreadable', () => {
    expect(originFromInitiatingFrame({ url: 'https://a.example/', isDestroyed: () => true })).toBe(
      UNKNOWN_EXTERNAL_APP_REQUEST_ORIGIN
    )
    expect(
      originFromInitiatingFrame({
        get url(): string {
          throw new Error('destroyed')
        }
      })
    ).toBe(UNKNOWN_EXTERNAL_APP_REQUEST_ORIGIN)
  })

  it('reads a known guest document only when that document is the source', () => {
    expect(
      originFromGuestDocument({
        getURL: () => 'https://login.example.com/sso',
        mainFrame: { url: 'https://login.example.com/sso' }
      })
    ).toBe('https://login.example.com')
  })
})
