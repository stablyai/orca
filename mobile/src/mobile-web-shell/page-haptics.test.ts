// Assert actual Expo calls so the page cannot silently fork native platform styles; mocking platform/haptics would only test the mapping table.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_HAPTICS_KINDS } from './bridge/bridge-haptics-notify'

type MockDevice = { platform: { OS: 'ios' | 'android' }; calls: string[] }

// Hoist the call log because vi.mock factories run before ordinary initializers.
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

// Android uses HapticFeedbackConstants through performAndroidHapticsAsync, which needs no VIBRATE permission.
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
  it('plays exactly one distinct device call for every kind', () => {
    for (const kind of BRIDGE_HAPTICS_KINDS) {
      playPageHaptic(kind)
    }
    expect(calls).toHaveLength(BRIDGE_HAPTICS_KINDS.length)
    expect(new Set(calls).size).toBe(BRIDGE_HAPTICS_KINDS.length)
  })
})
