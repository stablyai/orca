import { describe, expect, it } from 'vitest'
import {
  planMobileChatPrependResize,
  type MobileChatPrependAnchor
} from './mobile-native-chat-prepend-anchor'

function plan(
  overrides: Partial<Parameters<typeof planMobileChatPrependResize>[0]> = {}
): ReturnType<typeof planMobileChatPrependResize> {
  return planMobileChatPrependResize({
    anchor: null,
    following: false,
    hasItems: true,
    height: 400,
    offsetY: 20,
    historyHeadId: 'a1',
    ...overrides
  })
}

const armed: MobileChatPrependAnchor = { height: 400, historyHeadId: 'a1' }

describe('planMobileChatPrependResize', () => {
  it('shifts by the inserted height using the offset at insertion', () => {
    expect(plan({ anchor: armed, height: 900, offsetY: 80, historyHeadId: 'a0' })).toEqual({
      anchor: null,
      scrollOffset: 580
    })
  })

  it('does not consume the anchor when only the tail grows', () => {
    const held = plan({ anchor: armed, height: 480, offsetY: 80, historyHeadId: 'a1' })
    expect(held.scrollOffset).toBeNull()
    expect(held.anchor).toEqual({ height: 480, historyHeadId: 'a1' })
    expect(
      plan({ anchor: held.anchor, height: 900, offsetY: 80, historyHeadId: 'a0' }).scrollOffset
    ).toBe(500)
  })

  it('drops the anchor when the head changes without added height', () => {
    expect(plan({ anchor: armed, height: 400, historyHeadId: 'a0' })).toEqual({
      anchor: null,
      scrollOffset: null
    })
  })

  it('does not shift when the armed row was trimmed out of the window', () => {
    expect(
      plan({
        anchor: armed,
        height: 900,
        offsetY: 80,
        historyHeadId: 'a2',
        armedHeadRetained: false
      })
    ).toEqual({ anchor: null, scrollOffset: null })
  })

  it('pins a followed tail and leaves a detached reader still', () => {
    expect(plan({ following: true, height: 900 }).scrollOffset).toBe(900)
    expect(plan({ height: 900 }).scrollOffset).toBeNull()
  })
})
