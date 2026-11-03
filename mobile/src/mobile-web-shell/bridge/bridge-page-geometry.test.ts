import { describe, expect, it } from 'vitest'
import { createFakeBridgePortPair } from './bridge-port-pair-test-harness'
import {
  EMPTY_PAGE_GEOMETRY,
  pageOcclusions,
  type BridgePageGeometry
} from './bridge-page-geometry'

const GEOMETRY: BridgePageGeometry = {
  sideRail: true,
  occlusions: [{ x: 0, y: 0, width: 124, height: 84 }]
}

describe('page geometry over the bridge', () => {
  it('translates and clips native occlusions into the WebView frame', () => {
    expect(
      pageOcclusions(
        [
          { x: 20, y: 30, width: 100, height: 90 },
          { x: 0, y: 0, width: 20, height: 20 },
          { x: 300, y: 300, width: 100, height: 100 }
        ],
        { x: 40, y: 50, width: 320, height: 320 }
      )
    ).toEqual([
      { x: 0, y: 0, width: 80, height: 70 },
      { x: 260, y: 250, width: 60, height: 70 }
    ])
    expect(pageOcclusions(GEOMETRY.occlusions, null)).toEqual([])
  })

  it('updates geometry in place, deduplicates it and clears it on rotation', async () => {
    const pair = createFakeBridgePortPair()
    await pair.flush()
    expect(pair.client.getShellSession()?.pageGeometry).toEqual(EMPTY_PAGE_GEOMETRY)
    const seen: BridgePageGeometry[] = []
    pair.client.onPageGeometryUpdate((geometry) => seen.push(geometry))
    pair.host.publishPageGeometry(GEOMETRY)
    await pair.flush()
    expect(pair.client.getShellSession()?.pageGeometry).toEqual(GEOMETRY)
    pair.host.publishPageGeometry({ ...GEOMETRY, occlusions: [...GEOMETRY.occlusions] })
    await pair.flush()
    expect(seen).toEqual([GEOMETRY])
    pair.host.publishPageGeometry(EMPTY_PAGE_GEOMETRY)
    await pair.flush()
    expect(seen).toEqual([GEOMETRY, EMPTY_PAGE_GEOMETRY])
  })

  it('salvages an init with invalid geometry without trusting its rectangles', async () => {
    for (const bad of [
      { ...GEOMETRY, occlusions: [{ x: -1, y: 0, width: 12, height: 84 }] },
      { ...GEOMETRY, occlusions: Array(17).fill(GEOMETRY.occlusions[0]) },
      { ...GEOMETRY, sideRail: 'yes' }
    ]) {
      const pair = createFakeBridgePortPair({
        rewriteToPage: (json) => {
          const frame = JSON.parse(json)
          return JSON.stringify(frame.type === 'init' ? { ...frame, pageGeometry: bad } : frame)
        }
      })
      await pair.flush()
      expect(pair.client.getShellSession()?.pageGeometry).toEqual(EMPTY_PAGE_GEOMETRY)
    }
  })
})

it('delivers D-pad space changes even when the side rail and occlusions are unchanged', async () => {
  const pair = createFakeBridgePortPair()
  await pair.flush()
  const seen: BridgePageGeometry[] = []
  pair.client.onPageGeometryUpdate((geometry) => seen.push(geometry))
  pair.host.publishPageGeometry({ ...GEOMETRY, directionPadAvailable: true })
  await pair.flush()
  pair.host.publishPageGeometry({ ...GEOMETRY, directionPadAvailable: false })
  await pair.flush()
  expect(seen).toEqual([
    { ...GEOMETRY, directionPadAvailable: true },
    { ...GEOMETRY, directionPadAvailable: false }
  ])
})
