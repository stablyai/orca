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
  it('retains confirmed Voice values and surfaces a rejected save', async () => {
    const operations = {
      load: vi.fn().mockResolvedValue({
        enabled: true,
        dictationMode: 'toggle',
        selectedModelId: '',
        models: []
      }),
      configure: vi.fn().mockRejectedValue(new Error('Desktop unavailable')),
      download: vi.fn(),
      delete: vi.fn()
    } as VoiceSettingsOperations
    await act(async () => {
      renderer = create(
        createElement(VoiceSettingsScreen, { operations, focused: true, onBack: vi.fn() })
      )
    })
    expect(renderer.root.findByProps({ testID: 'voice-enabled' }).props.value).toBe(true)
    await act(async () => {
      await renderer.root.findByProps({ testID: 'voice-enabled' }).props.onValueChange(false)
    })
    expect(renderer.root.findByProps({ testID: 'voice-enabled' }).props.value).toBe(true)
    expect(JSON.stringify(renderer.toJSON())).toContain('Desktop unavailable')
    expect(operations.configure).toHaveBeenCalledOnce()
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
  it('keeps notification controls disabled when preference loading fails', async () => {
    const operations = {
      permission: vi.fn().mockResolvedValue({
        granted: true,
        status: 'granted',
        canAskAgain: true,
        authorizationReflectsUserChoice: true
      }),
      preference: vi.fn().mockRejectedValue(new Error('storage failed')),
      openSettings: vi.fn()
    }
    await act(async () => {
      renderer = create(createElement(NotificationsScreen, { operations, onBack: vi.fn() }))
    })
    expect(renderer.root.findByProps({ testID: 'notification-enabled' }).props.disabled).toBe(true)
    expect(JSON.stringify(renderer.toJSON())).toContain('Could not load notification settings')
  })
})
