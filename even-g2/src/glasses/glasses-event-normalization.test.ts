import { describe, expect, it } from 'vitest'
import { createGlassesEventNormalizer } from './glasses-event-normalization'
import type { GlassesRawEvent } from './glasses-bridge'

function raw(overrides: Partial<GlassesRawEvent>): GlassesRawEvent {
  return { source: 'sys', eventType: undefined, ...overrides }
}

describe('createGlassesEventNormalizer', () => {
  it('maps eventType 0 to click', () => {
    const normalize = createGlassesEventNormalizer()
    expect(normalize(raw({ source: 'text', eventType: 0 }))).toEqual({ kind: 'click' })
  })

  it('maps eventType undefined to click (SDK CLICK-undefined quirk)', () => {
    const normalize = createGlassesEventNormalizer()
    expect(normalize(raw({ source: 'text', eventType: undefined }))).toEqual({ kind: 'click' })
  })

  it('ignores source for type mapping (sysEvent-sourced click still maps to click)', () => {
    const normalize = createGlassesEventNormalizer()
    expect(normalize(raw({ source: 'sys', eventType: 0 }))).toEqual({ kind: 'click' })
  })

  it('maps a list click with listItemIndex to listSelect with that index', () => {
    const normalize = createGlassesEventNormalizer()
    expect(
      normalize(raw({ source: 'list', eventType: 0, listItemIndex: 3, listItemName: 'three' }))
    ).toEqual({ kind: 'listSelect', index: 3, label: 'three' })
  })

  it('substitutes index -1 when listItemIndex is missing for item 0 but listItemName survives', () => {
    const normalize = createGlassesEventNormalizer()
    expect(normalize(raw({ source: 'list', eventType: undefined, listItemName: 'first' }))).toEqual(
      { kind: 'listSelect', index: -1, label: 'first' }
    )
  })

  it('finding #4: treats a list-source click with NEITHER metadata field as listSelect(-1), not a generic click', () => {
    const normalize = createGlassesEventNormalizer()
    expect(normalize(raw({ source: 'list', eventType: 0 }))).toEqual({
      kind: 'listSelect',
      index: -1,
      label: undefined
    })
  })

  it('finding #4: a sys-source click with neither metadata field still maps to a generic click', () => {
    const normalize = createGlassesEventNormalizer()
    expect(normalize(raw({ source: 'sys', eventType: 0 }))).toEqual({ kind: 'click' })
  })

  it('maps DOUBLE_CLICK, FOREGROUND_ENTER/EXIT, SYSTEM_EXIT, ABNORMAL_EXIT', () => {
    const normalize = createGlassesEventNormalizer()
    expect(normalize(raw({ eventType: 3 }))).toEqual({ kind: 'doubleClick' })
    expect(normalize(raw({ eventType: 4 }))).toEqual({ kind: 'foregroundEnter' })
    expect(normalize(raw({ eventType: 5 }))).toEqual({ kind: 'foregroundExit' })
    expect(normalize(raw({ eventType: 7 }))).toEqual({ kind: 'systemExit' })
    expect(normalize(raw({ eventType: 6 }))).toEqual({ kind: 'abnormalExit' })
  })

  it('maps SCROLL_TOP/SCROLL_BOTTOM to scrollPrev/scrollNext (outside the cooldown window)', () => {
    let t = 0
    const normalize = createGlassesEventNormalizer({ now: () => t })
    expect(normalize(raw({ eventType: 1 }))).toEqual({ kind: 'scrollPrev' })
    t = 301
    expect(normalize(raw({ eventType: 2 }))).toEqual({ kind: 'scrollNext' })
  })

  it('returns null for unrecognized event types (e.g. IMU_DATA_REPORT)', () => {
    const normalize = createGlassesEventNormalizer()
    expect(normalize(raw({ eventType: 8 }))).toBeNull()
  })

  describe('sys event dedupe window', () => {
    it('drops an identical sys event within the default 600ms window', () => {
      let t = 0
      const normalize = createGlassesEventNormalizer({ now: () => t })
      expect(normalize(raw({ source: 'sys', eventType: 7 }))).toEqual({ kind: 'systemExit' })
      t = 100
      expect(normalize(raw({ source: 'sys', eventType: 7 }))).toBeNull()
    })

    it('allows the duplicate again after the window elapses', () => {
      let t = 0
      const normalize = createGlassesEventNormalizer({ now: () => t })
      normalize(raw({ source: 'sys', eventType: 7 }))
      t = 601
      expect(normalize(raw({ source: 'sys', eventType: 7 }))).toEqual({ kind: 'systemExit' })
    })

    it('does not dedupe a different eventType arriving within the window', () => {
      let t = 0
      const normalize = createGlassesEventNormalizer({ now: () => t })
      normalize(raw({ source: 'sys', eventType: 7 }))
      t = 50
      expect(normalize(raw({ source: 'sys', eventType: 4 }))).toEqual({ kind: 'foregroundEnter' })
    })

    it('respects a custom sysDedupeWindowMs', () => {
      let t = 0
      const normalize = createGlassesEventNormalizer({ now: () => t, sysDedupeWindowMs: 50 })
      normalize(raw({ source: 'sys', eventType: 7 }))
      t = 60
      expect(normalize(raw({ source: 'sys', eventType: 7 }))).toEqual({ kind: 'systemExit' })
    })
  })

  describe('scroll cooldown', () => {
    it('drops a second scroll within the default 300ms cooldown', () => {
      let t = 0
      const normalize = createGlassesEventNormalizer({ now: () => t })
      expect(normalize(raw({ source: 'text', eventType: 1 }))).toEqual({ kind: 'scrollPrev' })
      t = 100
      expect(normalize(raw({ source: 'text', eventType: 2 }))).toBeNull()
    })

    it('allows a scroll again after the cooldown elapses', () => {
      let t = 0
      const normalize = createGlassesEventNormalizer({ now: () => t })
      normalize(raw({ source: 'text', eventType: 1 }))
      t = 301
      expect(normalize(raw({ source: 'text', eventType: 2 }))).toEqual({ kind: 'scrollNext' })
    })

    it('respects a custom scrollCooldownMs', () => {
      let t = 0
      const normalize = createGlassesEventNormalizer({ now: () => t, scrollCooldownMs: 10 })
      normalize(raw({ source: 'text', eventType: 1 }))
      t = 11
      expect(normalize(raw({ source: 'text', eventType: 1 }))).toEqual({ kind: 'scrollPrev' })
    })
  })
})
