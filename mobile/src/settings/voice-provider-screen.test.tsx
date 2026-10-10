import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VoiceProviderScreen from './voice-provider-screen'
import { cabinetState, voiceOperations } from './voice-cabinet.test-fixture'
import { speechProvidersStateSchema } from '../dictation/speech-provider-reply-schema'

const openURL = vi.hoisted(() => vi.fn())

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  TextInput: 'TextInput',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  ActivityIndicator: 'ActivityIndicator',
  Linking: { openURL },
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) }
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 })
}))
vi.mock('lucide-react-native', () => ({
  AudioLines: 'Icon',
  Check: 'Icon',
  ChevronLeft: 'Icon',
  Download: 'Icon',
  ExternalLink: 'Icon',
  KeyRound: 'Icon',
  Laptop: 'Icon',
  Lock: 'Icon',
  Plus: 'Icon',
  RefreshCw: 'Icon',
  ShieldCheck: 'Icon',
  Trash2: 'Icon',
  X: 'Icon'
}))
vi.mock('../platform/text-input-font-size', () => ({ TEXT_INPUT_FONT_SIZE: 14 }))
vi.mock('../components/BottomDrawer', async () => {
  const { createElement: h } = await import('react')
  return {
    BottomDrawer: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
      visible ? h('Drawer', null, children) : null
  }
})
vi.mock('../components/ConfirmModal', async () => {
  const { createElement: h } = await import('react')
  return {
    ConfirmModal: (props: { visible: boolean; onConfirm: () => void; title: string }) =>
      props.visible ? h('Confirm', { onConfirm: props.onConfirm, title: props.title }) : null
  }
})

let renderer: ReactTestRenderer

afterEach(() => {
  act(() => renderer?.unmount())
  openURL.mockReset()
})

function text(): string {
  return JSON.stringify(renderer.toJSON())
}

async function press(testID: string): Promise<void> {
  await act(async () => {
    renderer.root.findByProps({ testID }).props.onPress()
  })
}

async function mount(
  operations: ReturnType<typeof voiceOperations>['operations'],
  providerId: string
): Promise<void> {
  await act(async () => {
    renderer = create(
      createElement(VoiceProviderScreen, { operations, focused: true, providerId, onBack: vi.fn() })
    )
  })
}

async function typeKey(value: string): Promise<void> {
  await act(async () => {
    renderer.root.findByProps({ testID: 'speech-provider-key-input' }).props.onChangeText(value)
  })
}

describe('voice provider screen', () => {
  it('shows a provider of an unknown kind read-only, without key controls', async () => {
    const wire = {
      ...cabinetState(),
      providers: [
        {
          id: 'acme',
          kind: 'hybrid',
          label: 'Acme',
          keyConfigured: false,
          models: [{ id: 'acme-1', label: 'Acme One', status: 'ready' }]
        }
      ]
    }
    const { operations } = voiceOperations({
      list: vi.fn().mockResolvedValue(speechProvidersStateSchema.parse(wire))
    })
    await mount(operations, 'acme')
    expect(text()).toContain('Acme One')
    expect(text()).not.toContain('API KEY')
    expect(renderer.root.findAllByProps({ testID: 'voice-provider-add-key' })).toHaveLength(0)
    expect(text()).toContain('Update Orca on this phone to manage Acme')
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Use Acme One' })).toHaveLength(0)
  })

  it('verifies and saves a new key, then shows the provider connected', async () => {
    const connected = cabinetState()
    const deepgram = connected.providers.find((entry) => entry.id === 'deepgram')
    if (deepgram) {
      deepgram.keyConfigured = true
      deepgram.keyHint = '…9z9z'
    }
    const { operations, providerOps } = voiceOperations({
      saveKey: vi.fn().mockResolvedValue(connected)
    })
    await mount(operations, 'deepgram')
    expect(text()).toContain('Add API key')

    await press('voice-provider-add-key')
    const input = renderer.root.findByProps({ testID: 'speech-provider-key-input' })
    expect(input.props.secureTextEntry).toBe(true)
    expect(input.props.accessibilityLabel).toBe('Deepgram API key')
    expect(input.props.autoCorrect).toBe(false)
    expect(input.props.autoCapitalize).toBe('none')
    await typeKey('  dg-secret-key  ')
    await press('speech-provider-key-save')

    expect(providerOps.saveKey).toHaveBeenCalledWith('deepgram', 'dg-secret-key')
    expect(renderer.root.findAllByProps({ testID: 'speech-provider-key-input' })).toHaveLength(0)
    expect(text()).toContain('••••••••9z9z')
    expect(text()).not.toContain('dg-secret-key')
  })

  it('keeps the drawer open with the host message when the provider rejects the key', async () => {
    const { operations } = voiceOperations({
      saveKey: vi.fn().mockRejectedValue(new Error('Deepgram rejected this API key (401).'))
    })
    await mount(operations, 'deepgram')
    await press('voice-provider-add-key')
    await typeKey('wrong-key')
    await press('speech-provider-key-save')
    expect(text()).toContain('Deepgram rejected this API key (401).')
    expect(renderer.root.findAllByProps({ testID: 'speech-provider-key-input' })).toHaveLength(1)
  })

  it('opens the provider console from the key drawer', async () => {
    const { operations } = voiceOperations({})
    await mount(operations, 'deepgram')
    await press('voice-provider-get-key')
    expect(openURL).toHaveBeenCalledWith('https://console.deepgram.com/')
  })

  it('reports a failed connection test inline', async () => {
    const { operations, providerOps } = voiceOperations({
      testKey: vi
        .fn()
        .mockResolvedValue({ ok: false, message: 'Soniox rejected this API key (401).' })
    })
    await mount(operations, 'soniox')
    await press('voice-provider-test-key')
    expect(providerOps.testKey).toHaveBeenCalledWith('soniox')
    expect(text()).toContain('Soniox rejected this API key (401).')
    expect(text()).toContain('Failed')
  })

  it('removes the key only after the confirmation', async () => {
    const { operations, providerOps } = voiceOperations({})
    await mount(operations, 'soniox')
    await press('voice-provider-remove-key')
    expect(providerOps.clearKey).not.toHaveBeenCalled()
    await act(async () => {
      renderer.root.findByProps({ title: 'Remove Soniox key?' }).props.onConfirm()
    })
    expect(providerOps.clearKey).toHaveBeenCalledWith('soniox')
  })

  it('manages on-device models without an API key section', async () => {
    const { operations } = voiceOperations({})
    await mount(operations, 'local')
    expect(text()).not.toContain('API KEY')
    await act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Download Parakeet' }).props.onPress()
    })
    expect(operations.download).toHaveBeenCalledWith('parakeet')
    await act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Use Whisper Tiny' }).props.onPress()
    })
    expect(operations.configure).toHaveBeenCalledWith({ enabled: true, modelId: 'whisper-tiny' })
  })

  describe('fallback states', () => {
    it('asks to connect a desktop when there is none', async () => {
      await act(async () => {
        renderer = create(
          createElement(VoiceProviderScreen, {
            operations: null,
            focused: true,
            providerId: 'deepgram',
            onBack: vi.fn()
          })
        )
      })
      expect(text()).toContain('Connect to a desktop to manage speech providers.')
    })

    it('says so when the desktop does not offer the provider', async () => {
      const { operations } = voiceOperations({})
      await mount(operations, 'no-such-provider')
      expect(text()).toContain('This desktop does not offer that provider.')
    })

    it('shows the host error when the provider list fails', async () => {
      const { operations } = voiceOperations({
        list: vi.fn().mockRejectedValue(new Error('Desktop refused the request.'))
      })
      await mount(operations, 'deepgram')
      expect(text()).toContain('Desktop refused the request.')
    })
  })
})
