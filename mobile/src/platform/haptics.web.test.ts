/**
 * The web form: the page has no haptics of its own, so the shell is asked for one.
 *
 * Every case asserts the kind as well as the count. A seam that posted something for all five
 * names would pass a test that only counted, and the five kinds are the whole content of the frame.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_HAPTICS_KINDS } from '../mobile-web-shell/bridge/bridge-haptics-notify'
import {
  publishHapticsNotifier,
  triggerEdgeBump,
  triggerError,
  triggerMediumImpact,
  triggerSelection,
  triggerSuccess
} from './haptics.web'

const asked: string[] = []

beforeEach(() => {
  asked.length = 0
  publishHapticsNotifier((kind) => {
    asked.push(kind)
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the haptic each page function asks the shell for', () => {
  // Kind first, because the title reads the first argument: `%#` consumes none, so with the
  // function in front `%s` printed its whole body as the name of the case.
  it.each([
    ['mediumImpact', triggerMediumImpact],
    ['selection', triggerSelection],
    ['success', triggerSuccess],
    ['error', triggerError],
    ['edgeBump', triggerEdgeBump]
  ] as const)('posts exactly one notify, carrying %s', (kind, trigger) => {
    trigger()
    expect(asked).toEqual([kind])
  })

  it('covers every kind the notify accepts, so no name is left on a no-op', () => {
    // The two halves measured against each other: the five functions the app's screens call, and
    // the five kinds the frame admits. A function missing here is a dead tap on the page.
    for (const trigger of [
      triggerMediumImpact,
      triggerSelection,
      triggerSuccess,
      triggerError,
      triggerEdgeBump
    ]) {
      trigger()
    }
    expect([...asked].sort()).toEqual([...BRIDGE_HAPTICS_KINDS].sort())
  })

  it('posts one frame per call, because a scrolling list calls once per row', () => {
    for (let row = 0; row < 12; row += 1) {
      triggerSelection()
    }
    expect(asked).toHaveLength(12)
  })
})

describe('a shell that will not play it', () => {
  it('says nothing, because nobody reads the answer and every row tap would say it again', () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    publishHapticsNotifier(() => false)
    expect(() => triggerSelection()).not.toThrow()
    expect(warned).not.toHaveBeenCalled()
  })

  it('asks nothing at all in a document that published no notifier', async () => {
    // A fresh module, because the notifier is module state and every case above has published one.
    vi.resetModules()
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fresh: typeof import('./haptics.web') = await import('./haptics.web')
    expect(() => fresh.triggerError()).not.toThrow()
    expect(asked).toEqual([])
    expect(warned).not.toHaveBeenCalled()
  })
})
