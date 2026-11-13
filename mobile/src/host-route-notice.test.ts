import { describe, expect, it } from 'vitest'
import { hostRouteNoticeMessage } from './host-route-notice'

describe('hostRouteNoticeMessage', () => {
  // A plain lookup returns Object.prototype members, which would hand the banner a function.
  it('renders nothing for prototype keys', () => {
    expect(hostRouteNoticeMessage('toString')).toBeNull()
    expect(hostRouteNoticeMessage('constructor')).toBeNull()
    expect(hostRouteNoticeMessage('__proto__')).toBeNull()
  })
})
