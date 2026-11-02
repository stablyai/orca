import { describe, expect, it } from 'vitest'
import { mobileResourceManagerRouteTarget } from './mobile-resource-manager-route'

describe('mobile resource manager route', () => {
  it('keeps the host id raw for the navigator to encode', () => {
    expect(mobileResourceManagerRouteTarget('host/one')).toEqual({
      name: '[hostId]/resource-manager',
      params: { hostId: 'host/one' }
    })
  })
})
