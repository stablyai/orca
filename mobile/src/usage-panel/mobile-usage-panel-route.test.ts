import { describe, expect, it } from 'vitest'
import { mobileUsagePanelRouteTarget } from './mobile-usage-panel-route'

describe('mobile usage panel route', () => {
  it('keeps the host id raw for the navigator to encode', () => {
    expect(mobileUsagePanelRouteTarget('host/one')).toEqual({
      name: '[hostId]/usage-panel',
      params: { hostId: 'host/one' }
    })
  })
})
