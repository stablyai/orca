import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VoiceSettingsScreen from './voice-settings-screen'
import type { VoiceSettingsOperations } from './voice-settings-operations'

// Why: the sibling state test stubs the poller, so it can only prove the screen's local
// machine. This one runs the real useDictationSetupPoller, whose refreshNow is gated on
// visible && foreground, to prove the rejected-save recovery actually reaches the wire.
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  Switch: 'Switch',
  ScrollView: 'ScrollView',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) }
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 })
}))
vi.mock('lucide-react-native', () => ({ ChevronLeft: 'Icon', ChevronRight: 'Icon' }))
vi.mock('../components/BottomDrawer', () => ({ BottomDrawer: () => null }))
vi.mock('../components/VoiceModelList', () => ({ VoiceModelList: () => null }))

let renderer: ReactTestRenderer

afterEach(() => {
  act(() => renderer?.unmount())
})

describe('voice settings poller integration', () => {
  it('reaches the real poller refresh after a rejected save', async () => {
    let rejectConfigure: (error: Error) => void = () => {}
    const operations = {
      load: vi.fn().mockResolvedValue({
        enabled: true,
        dictationMode: 'toggle',
        selectedModelId: '',
        models: []
      }),
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
    const loadsAfterMount = (operations.load as ReturnType<typeof vi.fn>).mock.calls.length
    expect(loadsAfterMount).toBeGreaterThan(0)

    await act(async () => {
      renderer.root.findByProps({ testID: 'voice-enabled' }).props.onValueChange(false)
    })
    await act(async () => {
      rejectConfigure(new Error('Desktop unavailable'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect((operations.load as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      loadsAfterMount + 1
    )
  })

  it('drops the recovery read once the screen is no longer focused', async () => {
    let rejectConfigure: (error: Error) => void = () => {}
    const operations = {
      load: vi.fn().mockResolvedValue({
        enabled: true,
        dictationMode: 'toggle',
        selectedModelId: '',
        models: []
      }),
      configure: vi.fn().mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectConfigure = reject
          })
      ),
      download: vi.fn(),
      delete: vi.fn()
    } as VoiceSettingsOperations
    const onBack = vi.fn()
    await act(async () => {
      renderer = create(createElement(VoiceSettingsScreen, { operations, focused: true, onBack }))
    })
    await act(async () => {
      renderer.root.findByProps({ testID: 'voice-enabled' }).props.onValueChange(false)
    })
    await act(async () => {
      renderer.update(createElement(VoiceSettingsScreen, { operations, focused: false, onBack }))
    })
    const loadsBeforeRejection = (operations.load as ReturnType<typeof vi.fn>).mock.calls.length

    await act(async () => {
      rejectConfigure(new Error('Desktop unavailable'))
      await Promise.resolve()
      await Promise.resolve()
    })
    // The controller's visible && foreground gate is base's behaviour, preserved here.
    expect((operations.load as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      loadsBeforeRejection
    )
  })
})
