import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VoiceSettingsScreen from './voice-settings-screen'
import type { VoiceSettingsOperations } from './voice-settings-operations'
import type { MobileSpeechSetup } from '../dictation/mobile-dictation-setup'

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
    // The poller is gated on focus, so no read runs and only the initial flag decides
    // this paint. Base started it false and flashed the error card here.
    expect(operations.load).not.toHaveBeenCalled()
    expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(1)
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
    // The failed read leaves the error card up, exactly as base did.
    expect(JSON.stringify(renderer.toJSON())).toContain('Desktop unavailable')
    expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(0)

    await act(async () => {
      renderer.update(createElement(VoiceSettingsScreen, { operations, focused: false, onBack }))
    })
    await act(async () => {
      renderer.update(createElement(VoiceSettingsScreen, { operations, focused: true, onBack }))
    })
    expect((operations.load as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
    // Base re-showed the spinner on re-entry; the stale error must not sit there during the retry.
    expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(1)
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
    // The controller's visible && foreground gate is base's behaviour, preserved here.
    expect((operations.load as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      loadsBeforeRejection
    )
  })
  it('keeps the latest switch choice when multiple desktop writes are delayed', async () => {
    const initial: MobileSpeechSetup = {
      enabled: true,
      dictationMode: 'toggle',
      selectedModelId: '',
      models: []
    }
    const replies: Array<(value: typeof initial) => void> = []
    const operations: VoiceSettingsOperations = {
      load: vi.fn().mockResolvedValue(initial),
      configure: vi.fn(() => new Promise<MobileSpeechSetup>((resolve) => replies.push(resolve))),
      download: vi.fn(),
      delete: vi.fn()
    }
    await act(async () => {
      renderer = create(
        createElement(VoiceSettingsScreen, { operations, focused: true, onBack() {} })
      )
    })
    const toggle = () => renderer.root.findByProps({ testID: 'voice-enabled' }).props
    await act(async () => {
      toggle().onValueChange(false)
    })
    await act(async () => {
      toggle().onValueChange(true)
    })
    expect(toggle().value).toBe(true)
    expect(operations.configure).toHaveBeenCalledTimes(1)
    await act(async () => {
      replies[0]!({ ...initial, enabled: false })
    })
    expect(operations.configure).toHaveBeenCalledTimes(2)
    expect(toggle().value).toBe(true)
    await act(async () => {
      replies[1]!({ ...initial, enabled: true })
    })
    expect(toggle().value).toBe(true)
  })

  it('loads the replacement desktop independently of the previous desktop pending mutation', async () => {
    const initial: MobileSpeechSetup = {
      enabled: true,
      dictationMode: 'toggle',
      selectedModelId: '',
      models: []
    }
    let finishOldWrite = (_value: MobileSpeechSetup) => {}
    const previous: VoiceSettingsOperations = {
      load: vi.fn().mockResolvedValue(initial),
      configure: vi.fn(
        () =>
          new Promise<MobileSpeechSetup>((resolve) => {
            finishOldWrite = resolve
          })
      ),
      download: vi.fn(),
      delete: vi.fn()
    }
    const next: VoiceSettingsOperations = {
      load: vi.fn().mockResolvedValue({ ...initial, enabled: false, dictationMode: 'hold' }),
      configure: vi.fn(),
      download: vi.fn(),
      delete: vi.fn()
    }
    const props = { focused: true, onBack() {} }
    await act(async () => {
      renderer = create(createElement(VoiceSettingsScreen, { ...props, operations: previous }))
    })
    await act(async () => {
      renderer.root.findByProps({ testID: 'voice-enabled' }).props.onValueChange(false)
    })
    await act(async () => {
      renderer.update(createElement(VoiceSettingsScreen, { ...props, operations: next }))
    })
    expect(next.load).toHaveBeenCalledOnce()
    await act(async () => finishOldWrite(initial))
    expect(renderer.root.findByProps({ testID: 'voice-enabled' }).props.value).toBe(false)
  })
})
