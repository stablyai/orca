/**
 * The page's haptic is the app's haptic.
 *
 * Asserted against `expo-haptics` rather than against `platform/haptics`: a test that mocked the
 * app's own module would pin this file's table and prove nothing about the thing a hand feels, and
 * the whole reason haptics ride one mapping is that the `Platform.OS` split and the Android
 * `HapticFeedbackConstants` must not be written twice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_HAPTICS_KINDS, type BridgeHapticsKind } from './bridge/bridge-haptics-notify'

/** Annotated rather than asserted: the platform is a two-value union and the log starts empty. */
type MockDevice = { platform: { OS: 'ios' | 'android' }; calls: string[] }

// Hoisted, because `vi.mock` is: a factory closing over an ordinary `const` reads it before its
// initializer has run. The device call each haptic makes is the only thing recorded.
const device = vi.hoisted((): MockDevice => ({ platform: { OS: 'ios' }, calls: [] }))
const { calls, platform } = device

vi.mock('react-native', () => ({ Platform: device.platform }))

vi.mock('expo-haptics', () => ({
  impactAsync: (style: string) => {
    device.calls.push(`impact:${style}`)
    return Promise.resolve()
  },
  selectionAsync: () => {
    device.calls.push('selection')
    return Promise.resolve()
  },
  notificationAsync: (type: string) => {
    device.calls.push(`notification:${type}`)
    return Promise.resolve()
  },
  performAndroidHapticsAsync: (constant: string) => {
    device.calls.push(`android:${constant}`)
    return Promise.resolve()
  },
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
  AndroidHaptics: {
    Long_Press: 'long-press',
    Gesture_Start: 'gesture-start',
    Confirm: 'confirm',
    Reject: 'reject',
    Clock_Tick: 'clock-tick'
  }
}))

import { playPageHaptic } from './page-haptics'

beforeEach(() => {
  calls.length = 0
  platform.OS = 'ios'
})

describe('the haptic a page asked for, on iOS', () => {
  it.each([
    ['mediumImpact', 'impact:medium'],
    ['selection', 'selection'],
    ['success', 'notification:success'],
    ['error', 'notification:error'],
    ['edgeBump', 'impact:light']
  ] as const)('plays %s as %s', (kind, expected) => {
    playPageHaptic(kind)
    expect(calls).toEqual([expected])
  })
})

/**
 * The other platform, unchanged: `performAndroidHapticsAsync` reaches
 * `HapticFeedbackConstants`, which works with no `VIBRATE` permission and is why the split exists.
 */
describe('the same haptic on Android', () => {
  it.each([
    ['mediumImpact', 'android:long-press'],
    ['selection', 'android:gesture-start'],
    ['success', 'android:confirm'],
    ['error', 'android:reject'],
    ['edgeBump', 'android:clock-tick']
  ] as const)('plays %s as %s', (kind, expected) => {
    platform.OS = 'android'
    playPageHaptic(kind)
    expect(calls).toEqual([expected])
  })
})

describe('the kinds and the functions behind them', () => {
  it('spends exactly one call per notify, which is what a per-row tap can afford', () => {
    for (const kind of BRIDGE_HAPTICS_KINDS) {
      playPageHaptic(kind)
    }
    expect(calls).toHaveLength(BRIDGE_HAPTICS_KINDS.length)
  })

  /**
   * Every kind reaches a different device call, which is what says the table has no duplicate row.
   *
   * A table mapping two kinds to one function would pass every case above — each still plays
   * something — and would mean a Save that felt like a failure. The third direction, a haptic
   * `haptics.ts` grows with no kind of its own, is the census's:
   * `config/scripts/mobile-web-app-haptics-seam.test.mjs` reads both files' names.
   */
  it('plays a different device call for every kind, so no two share a row', () => {
    for (const kind of BRIDGE_HAPTICS_KINDS) {
      playPageHaptic(kind)
    }
    expect(new Set(calls).size).toBe(BRIDGE_HAPTICS_KINDS.length)
  })
})

describe('the kind union', () => {
  it('is the five the app has and nothing else', () => {
    const kinds: readonly BridgeHapticsKind[] = BRIDGE_HAPTICS_KINDS
    expect([...kinds]).toEqual(['mediumImpact', 'selection', 'success', 'error', 'edgeBump'])
  })
})
