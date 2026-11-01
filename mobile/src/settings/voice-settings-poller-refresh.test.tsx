import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VoiceSettingsScreen from './voice-settings-screen'
import type { VoiceSettingsOperations } from './voice-settings-operations'
import { findAllByHostType } from '../test-support/react-test-renderer-host-nodes'

// Use the real focus-gated poller to verify rejected saves trigger a load; the sibling state test stubs it.
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) }
}))
vi.mock('../components/MobileSwitch', () => ({ MobileSwitch: 'Switch' }))
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

  it('shows the spinner, not the error card, when it mounts before focus lands', async () => {
    const operations = {
      load: vi.fn(),
      configure: vi.fn(),
      download: vi.fn(),
      delete: vi.fn()
    } as VoiceSettingsOperations
    await act(async () => {
      renderer = create(
        createElement(VoiceSettingsScreen, { operations, focused: false, onBack: vi.fn() })
      )
    })
    // Unfocused polling cannot start a read; initial state must prevent an error-card flash.
    expect(operations.load).not.toHaveBeenCalled()
    expect(findAllByHostType(renderer.root, 'ActivityIndicator')).toHaveLength(1)
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Failed to load voice settings')
  })

  it('re-shows the spinner when a refocus retries a failed load', async () => {
    const operations = {
      load: vi
        .fn()
        .mockRejectedValueOnce(new Error('Desktop unavailable'))
        .mockImplementationOnce(() => new Promise(() => {})),
      configure: vi.fn(),
      download: vi.fn(),
      delete: vi.fn()
    } as VoiceSettingsOperations
    const onBack = vi.fn()
    await act(async () => {
      renderer = create(createElement(VoiceSettingsScreen, { operations, focused: true, onBack }))
    })
    expect(JSON.stringify(renderer.toJSON())).toContain('Desktop unavailable')
    expect(findAllByHostType(renderer.root, 'ActivityIndicator')).toHaveLength(0)

    await act(async () => {
      renderer.update(createElement(VoiceSettingsScreen, { operations, focused: false, onBack }))
    })
    await act(async () => {
      renderer.update(createElement(VoiceSettingsScreen, { operations, focused: true, onBack }))
    })
    expect((operations.load as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
    // Re-entry retry must replace the stale error with a spinner.
    expect(findAllByHostType(renderer.root, 'ActivityIndicator')).toHaveLength(1)
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Desktop unavailable')
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
    expect((operations.load as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      loadsBeforeRejection
    )
  })
})
