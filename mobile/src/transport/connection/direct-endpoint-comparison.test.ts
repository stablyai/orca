import { describe, expect, it } from 'vitest'
import { isSameDirectEndpoint } from './direct-endpoint-comparison'

describe('mobile direct endpoint equality', () => {
  it('does not relearn the original LAN route just because status uses a trailing slash', () => {
    expect(isSameDirectEndpoint('ws://192.168.50.131:6768', 'ws://192.168.50.131:6768/')).toBe(true)
    expect(isSameDirectEndpoint('ws://192.168.50.131:6768', 'ws://192.168.50.135:6768/')).toBe(
      false
    )
  })
})
