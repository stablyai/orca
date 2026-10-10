import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VoiceSettingsScreen from './voice-settings-screen'
import { cabinetState, voiceOperations } from './voice-cabinet.test-fixture'

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
vi.mock('lucide-react-native', () => ({
  AudioLines: 'Icon',
  Check: 'Icon',
  ChevronLeft: 'Icon',
  ChevronRight: 'Icon',
  Cloud: 'Icon',
  Download: 'Icon',
  KeyRound: 'Icon',
  Languages: 'Icon',
  Laptop: 'Icon',
  Mic: 'Icon',
  Trash2: 'Icon'
}))
vi.mock('../components/BottomDrawer', async () => {
  const { createElement: h } = await import('react')
  return {
    BottomDrawer: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
      visible ? h('Drawer', null, children) : null
  }
})
vi.mock('../components/VoiceModelList', () => ({ VoiceModelList: () => null }))

let renderer: ReactTestRenderer

afterEach(() => {
  act(() => renderer?.unmount())
})

function text(): string {
  return JSON.stringify(renderer.toJSON())
}

async function press(testID: string): Promise<void> {
  await act(async () => {
    renderer.root.findByProps({ testID }).props.onPress()
  })
}

const onOpenCloudProviders = vi.fn()

async function mount(operations: ReturnType<typeof voiceOperations>['operations']) {
  const onOpenProvider = vi.fn()
  onOpenCloudProviders.mockClear()
  await act(async () => {
    renderer = create(
      createElement(VoiceSettingsScreen, {
        operations,
        focused: true,
        onBack: vi.fn(),
        onOpenProvider,
        onOpenCloudProviders
      })
    )
  })
  return onOpenProvider
}

describe('voice settings provider cabinet', () => {
  it('lists every provider with its connection status and the model in use', async () => {
    const { operations } = voiceOperations({})
    await mount(operations)
    expect(operations.load).not.toHaveBeenCalled()
    const json = text()
    expect(json).toContain('Soniox Real-time v5')
    // Cloud providers collapse into one entry; their rows live on the cloud providers screen.
    expect(json).toContain('Cloud providers')
    expect(json).toMatch(/1 connected of \d+/)
    expect(json).not.toContain('Not connected')
    expect(json).toContain('1 model downloaded')
    expect(json).toContain('Auto-detect')
  })

  it('keeps the legacy model list for a desktop without the cabinet', async () => {
    const { operations } = voiceOperations({ list: vi.fn().mockResolvedValue(null) })
    await mount(operations)
    expect(operations.load).toHaveBeenCalled()
    expect(text()).toContain('SPEECH MODEL')
    expect(text()).not.toContain('PROVIDERS')
  })

  it('keeps the cabinet on screen across a client swap and re-probes the new desktop', async () => {
    const first = voiceOperations({})
    await mount(first.operations)
    const legacy = voiceOperations({ list: vi.fn().mockResolvedValue(null) })
    await act(async () => {
      renderer.update(
        createElement(VoiceSettingsScreen, {
          operations: null,
          focused: false,
          onBack: vi.fn()
        })
      )
    })
    expect(text()).toContain('PROVIDERS')
    expect(text()).not.toContain('Connect to a desktop')
    await act(async () => {
      renderer.update(
        createElement(VoiceSettingsScreen, {
          operations: legacy.operations,
          focused: true,
          onBack: vi.fn()
        })
      )
    })
    expect(legacy.providerOps.list).toHaveBeenCalled()
    expect(legacy.operations.load).toHaveBeenCalled()
    expect(text()).toContain('SPEECH MODEL')
    expect(text()).not.toContain('PROVIDERS')
  })

  it('opens on-device models directly and cloud providers on their own screen', async () => {
    const { operations } = voiceOperations({})
    const onOpenProvider = await mount(operations)
    await press('voice-provider-local')
    expect(onOpenProvider).toHaveBeenCalledWith('local')
    await press('voice-cloud-providers')
    expect(onOpenCloudProviders).toHaveBeenCalledOnce()
  })

  it('picks a usable model and asks for one key per provider, not per model', async () => {
    const { operations } = voiceOperations({})
    const onOpenProvider = await mount(operations)
    await press('voice-model-picker')
    expect(text()).toContain('Choose a model')

    await act(async () => {
      renderer.root.findByProps({ testID: 'speech-provider-add-key-deepgram' }).props.onPress()
    })
    expect(onOpenProvider).toHaveBeenCalledWith('deepgram')

    await press('voice-model-picker')
    await press('speech-model-whisper-tiny')
    expect(operations.configure).toHaveBeenCalledWith({ enabled: true, modelId: 'whisper-tiny' })
  })

  it('writes the language through speech.providers.configure', async () => {
    const { operations, providerOps } = voiceOperations({
      setLanguage: vi.fn().mockResolvedValue(cabinetState({ language: 'uk' }))
    })
    await mount(operations)
    await press('voice-language-picker')
    await press('speech-language-uk')
    expect(providerOps.setLanguage).toHaveBeenCalledWith('uk')
    expect(text()).toContain('Ukrainian')
    expect(text()).not.toContain('A hint for cloud models')
  })
})
