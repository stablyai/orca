import { describe, expect, it } from 'vitest'

import { readBridgeClientMessage } from '../bridge/protocol/bridge-envelope'
import { createBridgeHostBack } from './bridge-host-back'

const claim = (extra: { edgeGuards?: unknown }) =>
  JSON.stringify({ v: 1, type: 'notify', name: 'back-claim', claimed: false, ...extra })

describe('back-claim edge guards', () => {
  it('reads the bands a page sends, without them from older pages, and refuses more than four', () => {
    const band = { top: 100, bottom: 144 }
    const withBands = readBridgeClientMessage(claim({ edgeGuards: [band] }))
    expect(withBands.ok && withBands.message).toMatchObject({ edgeGuards: [band] })
    const older = readBridgeClientMessage(claim({}))
    expect(older.ok && 'edgeGuards' in older.message).toBe(false)
    expect(
      readBridgeClientMessage(claim({ edgeGuards: Array.from({ length: 5 }, () => band) })).ok
    ).toBe(false)
  })

  it('clears the bands when the document ends, and leaves them alone for a page that sends none', () => {
    const reported: (readonly { top: number; bottom: number }[])[] = []
    const back = createBridgeHostBack({
      send: () => {},
      deliverable: () => true,
      onClaim: () => {},
      onEdgeGuards: (bands) => reported.push(bands)
    })
    back.readClaim(false)
    expect(reported).toEqual([])
    back.readClaim(false, [{ top: 100, bottom: 144 }])
    back.readReady()
    expect(reported).toEqual([[{ top: 100, bottom: 144 }], []])
  })
})
