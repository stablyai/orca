import { describe, expect, it } from 'vitest'
import { buildDialOrder } from './ordered-endpoint-dial'

const TS = 'ws://100.102.47.57:6768'
const LAN = 'ws://192.168.1.10:6768'
const CUSTOM = 'ws://10.0.0.5:6768'

describe('buildDialOrder', () => {
  it('cold start walks preferred order from index 0', () => {
    expect(
      buildDialOrder({
        endpoints: [TS, LAN],
        lastGoodEndpoint: LAN,
        mode: 'cold',
        stickyLastGood: true
      })
    ).toEqual([TS, LAN])
  })

  it('reconnect with sticky prefers last-good then remaining preferred order', () => {
    expect(
      buildDialOrder({
        endpoints: [TS, LAN, CUSTOM],
        lastGoodEndpoint: LAN,
        mode: 'reconnect',
        stickyLastGood: true
      })
    ).toEqual([LAN, TS, CUSTOM])
  })

  it('after one last-good miss, later passes use preferred order only', () => {
    expect(
      buildDialOrder({
        endpoints: [TS, LAN],
        lastGoodEndpoint: LAN,
        mode: 'reconnect',
        stickyLastGood: false
      })
    ).toEqual([TS, LAN])
  })

  it('ignores last-good outside the preferred list', () => {
    expect(
      buildDialOrder({
        endpoints: [TS, LAN],
        lastGoodEndpoint: 'ws://9.9.9.9:6768',
        mode: 'reconnect',
        stickyLastGood: true
      })
    ).toEqual([TS, LAN])
  })

  it('single-endpoint host order is unchanged', () => {
    expect(
      buildDialOrder({
        endpoints: [TS],
        lastGoodEndpoint: TS,
        mode: 'reconnect',
        stickyLastGood: true
      })
    ).toEqual([TS])
  })
})
