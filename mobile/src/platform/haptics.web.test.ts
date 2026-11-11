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
    // Check export/kind parity so adding a native haptic cannot silently leave page taps inert.
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
    // Reload the module to clear notifiers published by earlier cases.
    vi.resetModules()
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fresh: typeof import('./haptics.web') = await import('./haptics.web')
    expect(() => fresh.triggerError()).not.toThrow()
    expect(asked).toEqual([])
    expect(warned).not.toHaveBeenCalled()
  })
})
