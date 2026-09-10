import { createElement, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import NotificationsScreen from './notification-settings-screen'
import VoiceSettingsScreen from './voice-settings-screen'
import type { VoiceSettingsOperations } from './voice-settings-operations'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  Switch: 'Switch',
  ScrollView: 'ScrollView',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  AppState: { addEventListener: () => ({ remove() {} }) }
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 })
}))
vi.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void) => useEffect(callback, [callback])
}))
vi.mock('lucide-react-native', () => ({ ChevronLeft: 'Icon', ChevronRight: 'Icon' }))
vi.mock('../components/BottomDrawer', () => ({ BottomDrawer: () => null }))
vi.mock('../components/VoiceModelList', () => ({ VoiceModelList: () => null }))
vi.mock('../dictation/use-dictation-setup-poller', () => ({
  useDictationSetupPoller: ({ refresh }: { refresh: () => Promise<unknown> }) => {
    useEffect(() => {
      void refresh()
    }, [refresh])
    return refresh
  }
}))
let renderer: ReactTestRenderer

afterEach(() => {
  act(() => renderer?.unmount())
})
describe('shared settings screen state', () => {
  it('flips the Voice switch before the desktop replies and surfaces a rejected save', async () => {
    const loaded = {
      enabled: true,
      dictationMode: 'toggle',
      selectedModelId: '',
      models: []
    }
    let rejectConfigure: (error: Error) => void = () => {}
    const operations = {
      // Why: the reconcile read stays pending so the optimistic value and the
      // rejection message are both observable, as they are on a slow desktop.
      load: vi
        .fn()
        .mockResolvedValueOnce(loaded)
        .mockImplementation(() => new Promise(() => {})),
      configure: vi.fn().mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectConfigure = reject
          })
      ),
      download: vi.fn(),
      delete: vi.fn()
    } as VoiceSettingsOperations
    await act(async () => {
      renderer = create(
        createElement(VoiceSettingsScreen, { operations, focused: true, onBack: vi.fn() })
      )
    })
    const switchProps = () => renderer.root.findByProps({ testID: 'voice-enabled' }).props
    expect(switchProps().value).toBe(true)
    expect(switchProps().disabled).toBeUndefined()

    await act(async () => {
      switchProps().onValueChange(false)
    })
    // The switch moves on tap, before the desktop has answered.
    expect(switchProps().value).toBe(false)
    expect(switchProps().disabled).toBeUndefined()
    expect(operations.configure).toHaveBeenCalledOnce()

    await act(async () => {
      rejectConfigure(new Error('Desktop unavailable'))
      await Promise.resolve()
    })
    expect(JSON.stringify(renderer.toJSON())).toContain('Desktop unavailable')
    expect(operations.load).toHaveBeenCalledTimes(2)
  })
  it('shows the spinner, not the error card, while the first voice read is pending', async () => {
    const operations = {
      load: vi.fn().mockImplementation(() => new Promise(() => {})),
      configure: vi.fn(),
      download: vi.fn(),
      delete: vi.fn()
    } as VoiceSettingsOperations
    await act(async () => {
      renderer = create(
        createElement(VoiceSettingsScreen, { operations, focused: true, onBack: vi.fn() })
      )
    })
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Failed to load voice settings')
    expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(1)
  })
  it('drops a poll that resolves after a toggle instead of clobbering it', async () => {
    const loaded = {
      enabled: true,
      dictationMode: 'toggle',
      selectedModelId: '',
      models: []
    }
    let resolveStalePoll: (value: typeof loaded) => void = () => {}
    const shared = {
      load: vi
        .fn()
        .mockResolvedValueOnce(loaded)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveStalePoll = resolve
            })
        ),
      configure: vi.fn().mockImplementation(() => new Promise(() => {})),
      download: vi.fn(),
      delete: vi.fn()
    }
    const first = { ...shared } as VoiceSettingsOperations
    await act(async () => {
      renderer = create(
        createElement(VoiceSettingsScreen, { operations: first, focused: true, onBack: vi.fn() })
      )
    })
    const switchProps = () => renderer.root.findByProps({ testID: 'voice-enabled' }).props
    expect(switchProps().value).toBe(true)

    // A new operations identity restarts the poller, so a read is in flight below.
    const second = { ...shared } as VoiceSettingsOperations
    await act(async () => {
      renderer.update(
        createElement(VoiceSettingsScreen, { operations: second, focused: true, onBack: vi.fn() })
      )
    })
    expect(shared.load).toHaveBeenCalledTimes(2)

    await act(async () => {
      switchProps().onValueChange(false)
    })
    expect(switchProps().value).toBe(false)

    await act(async () => {
      resolveStalePoll(loaded)
      await Promise.resolve()
    })
    // Without the request-epoch fence the stale read would flip the switch back on.
    expect(switchProps().value).toBe(false)
  })
  it('does not enable notifications after denied OS permission', async () => {
    const denied = {
      granted: false,
      status: 'undetermined',
      canAskAgain: true,
      authorizationReflectsUserChoice: false
    }
    const operations = {
      permission: vi.fn().mockResolvedValue(denied),
      preference: vi.fn().mockResolvedValue({ enabled: false }),
      openSettings: vi.fn()
    }
    await act(async () => {
      renderer = create(createElement(NotificationsScreen, { operations, onBack: vi.fn() }))
    })
    await act(async () => {
      await renderer.root.findByProps({ testID: 'notification-enabled' }).props.onValueChange(true)
    })
    expect(operations.permission).toHaveBeenLastCalledWith(true)
    expect(operations.preference).toHaveBeenLastCalledWith(false)
    expect(renderer.root.findByProps({ testID: 'notification-enabled' }).props.value).toBe(false)
    expect(operations.openSettings).not.toHaveBeenCalled()
  })
  it('keeps the notification switch live while the read is pending and after it fails', async () => {
    let rejectPreference: (error: Error) => void = () => {}
    const operations = {
      permission: vi.fn().mockResolvedValue({
        granted: true,
        status: 'granted',
        canAskAgain: true,
        authorizationReflectsUserChoice: true
      }),
      preference: vi.fn().mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectPreference = reject
          })
      ),
      openSettings: vi.fn()
    }
    await act(async () => {
      renderer = create(createElement(NotificationsScreen, { operations, onBack: vi.fn() }))
    })
    const switchProps = () => renderer.root.findByProps({ testID: 'notification-enabled' }).props
    // Base gates only on a denied OS permission, so the control is live from first paint.
    expect(switchProps().disabled).toBe(false)

    await act(async () => {
      rejectPreference(new Error('storage failed'))
      await Promise.resolve()
    })
    expect(switchProps().disabled).toBe(false)
    expect(JSON.stringify(renderer.toJSON())).toContain('Could not load notification settings')
  })
})
