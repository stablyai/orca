import { expect, it } from 'vitest'
import {
  blurDuoRailFreeBand,
  focusDuoRailFreeBand,
  publishDuoRailFreeBand,
  readDuoRailFreeBand,
  releaseDuoRailFreeBand
} from './duo-rail-free-band'

// Effects in the order the page's host stack runs them: the main chat stays mounted under the worker.
it('reports the visible chat band through open-worker, a cancelled swipe and back', () => {
  const main = Symbol('main chat')
  const worker = Symbol('worker chat')
  publishDuoRailFreeBand(main, { top: 60, bottom: 500 })
  focusDuoRailFreeBand(main)
  expect(readDuoRailFreeBand()).toEqual({ top: 60, bottom: 500 })

  publishDuoRailFreeBand(worker, null)
  focusDuoRailFreeBand(worker)
  blurDuoRailFreeBand(main)
  publishDuoRailFreeBand(worker, { top: 60, bottom: 420 })
  // The hidden main chat re-measuring must not leak onto the worker.
  publishDuoRailFreeBand(main, { top: 60, bottom: 480 })
  expect(readDuoRailFreeBand()).toEqual({ top: 60, bottom: 420 })

  // A cancelled swipe changes no focus.
  expect(readDuoRailFreeBand()).toEqual({ top: 60, bottom: 420 })

  // Back: the main chat focuses before the worker blurs, and the worker's unmount lands after its slide.
  focusDuoRailFreeBand(main)
  blurDuoRailFreeBand(worker)
  releaseDuoRailFreeBand(worker)
  expect(readDuoRailFreeBand()).toEqual({ top: 60, bottom: 480 })

  // Leaving the main chat for a screen with no band (the host list) clears it.
  blurDuoRailFreeBand(main)
  expect(readDuoRailFreeBand()).toBeNull()
  releaseDuoRailFreeBand(main)
})
