import { describe, expect, it } from 'vitest'
import {
  nativeChatKeyboardIsReported,
  nativeChatKeyboardStaysLeaving,
  resolveNativeChatBottomPad,
  resolveNativeChatKeyboardDismissMode
} from './mobile-native-chat-keyboard-lift'

const IOS_KEYBOARD_HEIGHT = 336
const BOTTOM_INSET = 34
// The route lifts by the keyboard height minus the home indicator on iOS.
const COMMITTED_INSET = IOS_KEYBOARD_HEIGHT - BOTTOM_INSET

describe('nativeChatKeyboardIsReported', () => {
  it('is true for every phase that carries a frame', () => {
    // Both reported phases must agree, or the finger's direction changes would
    // wake React on every frame of the drag.
    expect(nativeChatKeyboardIsReported('settling')).toBe(true)
    expect(nativeChatKeyboardIsReported('dismissing')).toBe(true)
  })

  it('is false while the observer is silent', () => {
    expect(nativeChatKeyboardIsReported('unreported')).toBe(false)
  })
})

describe('resolveNativeChatKeyboardDismissMode', () => {
  it('follows the finger on iOS once the observer reports frames', () => {
    expect(resolveNativeChatKeyboardDismissMode('ios', true)).toBe('interactive')
  })

  it('will not drag a keyboard it cannot follow', () => {
    expect(resolveNativeChatKeyboardDismissMode('ios', false)).toBe('on-drag')
  })

  it('commits the hide on drag everywhere else', () => {
    expect(resolveNativeChatKeyboardDismissMode('android', true)).toBe('on-drag')
    expect(resolveNativeChatKeyboardDismissMode('web', true)).toBe('on-drag')
  })
})

describe('resolveNativeChatBottomPad', () => {
  it('falls back to the route inset while the keyboard observer is idle', () => {
    expect(
      resolveNativeChatBottomPad({
        phase: 'unreported',
        lastSettledPad: IOS_KEYBOARD_HEIGHT,
        liveKeyboardHeight: 0,
        committedInset: COMMITTED_INSET,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(IOS_KEYBOARD_HEIGHT)
  })

  it('keeps the composer clear of the home indicator with no keyboard', () => {
    expect(
      resolveNativeChatBottomPad({
        phase: 'unreported',
        lastSettledPad: IOS_KEYBOARD_HEIGHT,
        liveKeyboardHeight: 0,
        committedInset: 0,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(BOTTOM_INSET)
  })

  it('matches the route inset while the keyboard sits open', () => {
    expect(
      resolveNativeChatBottomPad({
        phase: 'settling',
        lastSettledPad: IOS_KEYBOARD_HEIGHT,
        liveKeyboardHeight: IOS_KEYBOARD_HEIGHT,
        committedInset: COMMITTED_INSET,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(IOS_KEYBOARD_HEIGHT)
  })

  it('rides the keyboard down mid-drag while the route inset is still stale', () => {
    // keyboardWillHide has not fired yet, so committedInset still reads full lift.
    expect(
      resolveNativeChatBottomPad({
        phase: 'dismissing',
        lastSettledPad: IOS_KEYBOARD_HEIGHT,
        liveKeyboardHeight: 180,
        committedInset: COMMITTED_INSET,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(180)
  })

  it('never lets a part-dragged keyboard pull the composer under the home indicator', () => {
    expect(
      resolveNativeChatBottomPad({
        phase: 'dismissing',
        lastSettledPad: IOS_KEYBOARD_HEIGHT,
        liveKeyboardHeight: 12,
        committedInset: COMMITTED_INSET,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(BOTTOM_INSET)
  })

  it('rests on the bottom inset once the drag commits', () => {
    expect(
      resolveNativeChatBottomPad({
        phase: 'unreported',
        lastSettledPad: IOS_KEYBOARD_HEIGHT,
        liveKeyboardHeight: 0,
        committedInset: 0,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(BOTTOM_INSET)
  })

  it('holds the lift when a restored keyboard reports no frame to follow', () => {
    // iOS can put the keyboard back with no animation for the observer to ride
    // (foregrounding with the composer focused), leaving its height at 0 while
    // the route already knows the keyboard is up.
    expect(
      resolveNativeChatBottomPad({
        phase: 'unreported',
        lastSettledPad: IOS_KEYBOARD_HEIGHT,
        liveKeyboardHeight: 0,
        committedInset: COMMITTED_INSET,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(IOS_KEYBOARD_HEIGHT)
  })
})

describe('resolveNativeChatBottomPad on an undocked keyboard', () => {
  // An iPad floating keyboard sits mid-screen: the observer reports the distance
  // from its top edge to the bottom of the window, which dwarfs its own panel.
  const FLOATING_TOP_EDGE = 900

  it('does not shove the composer up to a floating keyboard top edge', () => {
    expect(
      resolveNativeChatBottomPad({
        phase: 'settling',
        lastSettledPad: 0,
        liveKeyboardHeight: FLOATING_TOP_EDGE,
        committedInset: 260,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(260 + BOTTOM_INSET)
  })

  it('still lets a committed keyboard ride down past the route inset', () => {
    // Dismissing is the one phase where the frame must be allowed to lead: the
    // route has already zeroed its inset while the keyboard is still on screen.
    expect(
      resolveNativeChatBottomPad({
        phase: 'dismissing',
        lastSettledPad: IOS_KEYBOARD_HEIGHT,
        liveKeyboardHeight: 200,
        committedInset: 0,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(200)
  })

  it('goes straight to the settled lift as the keyboard opens', () => {
    // A part-risen frame must not pull the composer back down: the route is
    // already at the target, and following the frame would race it — losing
    // that race drops the composer to the home indicator and bounces it back.
    expect(
      resolveNativeChatBottomPad({
        phase: 'settling',
        lastSettledPad: IOS_KEYBOARD_HEIGHT,
        liveKeyboardHeight: 90,
        committedInset: COMMITTED_INSET,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(IOS_KEYBOARD_HEIGHT)
  })
})

describe('resolveNativeChatBottomPad while an undocked keyboard leaves', () => {
  it('caps the closing frame at the lift the keyboard actually settled on', () => {
    // The route has already zeroed its inset, so the settled pad is the only
    // ceiling left — without it a floating keyboard's top edge would fling the
    // composer most of the way up the screen for the whole close animation.
    expect(
      resolveNativeChatBottomPad({
        phase: 'dismissing',
        liveKeyboardHeight: 900,
        committedInset: 0,
        lastSettledPad: 294,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(294)
  })
})

describe('nativeChatKeyboardStaysLeaving', () => {
  it('latches on the first closing frame', () => {
    expect(
      nativeChatKeyboardStaysLeaving({ wasLeaving: false, isClosing: true, hasSettled: false })
    ).toBe(true)
  })

  it('holds through the upward pixels of a wobbling finger', () => {
    // Reanimated calls that movement OPENING even though the drag is still live.
    expect(
      nativeChatKeyboardStaysLeaving({ wasLeaving: true, isClosing: false, hasSettled: false })
    ).toBe(true)
  })

  it('releases once the keyboard settles either way', () => {
    expect(
      nativeChatKeyboardStaysLeaving({ wasLeaving: true, isClosing: false, hasSettled: true })
    ).toBe(false)
  })

  it('stays clear while a keyboard is genuinely coming up', () => {
    expect(
      nativeChatKeyboardStaysLeaving({ wasLeaving: false, isClosing: false, hasSettled: false })
    ).toBe(false)
  })
})
