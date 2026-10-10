import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileDictationSetupSheet } from './MobileDictationSetupSheet'
import { cabinetState } from '../settings/voice-cabinet.test-fixture'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileSpeechProvidersState } from '../dictation/speech-provider-reply-schema'

const fetchSpeechProviders = vi.hoisted(() => vi.fn())
const fetchDictationSetup = vi.hoisted(() => vi.fn())
const setDictationConfig = vi.hoisted(() => vi.fn())
const downloadDictationModel = vi.hoisted(() => vi.fn())

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  Switch: 'Switch',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) }
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('lucide-react-native', () => ({ Check: 'Icon', ChevronRight: 'Icon', Download: 'Icon' }))
vi.mock('../platform/haptics', () => ({ triggerError: vi.fn(), triggerSuccess: vi.fn() }))
vi.mock('./BottomDrawer', async () => {
  const { createElement: h } = await import('react')
  return {
    BottomDrawer: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
      visible ? h('Drawer', null, children) : null
  }
})
vi.mock('../settings/speech-model-grouped-list', async () => {
  const { createElement: h } = await import('react')
  return {
    SpeechModelGroupedList: ({ state }: { state: MobileSpeechProvidersState }) =>
      h('Grouped', { testID: 'grouped-models', language: state.language })
  }
})
vi.mock('../dictation/mobile-speech-providers', () => ({ fetchSpeechProviders }))
vi.mock('../dictation/mobile-dictation-setup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../dictation/mobile-dictation-setup')>()),
  fetchDictationSetup,
  setDictationConfig,
  downloadDictationModel
}))

let renderer: ReactTestRenderer | undefined

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  fetchSpeechProviders.mockReset()
  fetchDictationSetup.mockReset()
  setDictationConfig.mockReset()
  downloadDictationModel.mockReset()
})

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function fakeClient(): RpcClient {
  // Why: the sheet only passes the client to the mocked fetchers and keys state by identity.
  return Object.create(null)
}

async function render(client: RpcClient): Promise<void> {
  const element = createElement(MobileDictationSetupSheet, {
    visible: true,
    client,
    onClose: vi.fn()
  })
  await act(async () => {
    if (renderer) {
      renderer.update(element)
    } else {
      renderer = create(element)
    }
  })
}

function legacyAction(text: string): ReactTestInstance | undefined {
  let node = renderer?.root.findByProps({ children: text })
  while (node && String(node.type) !== 'Pressable') {
    node = node.parent ?? undefined
  }
  return node
}

function shownLanguages(): unknown[] {
  const nodes = renderer?.root.findAllByProps({ testID: 'grouped-models' }) ?? []
  return nodes.map((node) => node.props.language)
}

describe('MobileDictationSetupSheet client switch', () => {
  it('does not show the previous desktop state or error after the client changes', async () => {
    const oldRead = deferred<MobileSpeechProvidersState>()
    const newRead = deferred<MobileSpeechProvidersState>()
    const oldClient = fakeClient()
    const newClient = fakeClient()
    fetchSpeechProviders.mockImplementation((client: RpcClient) =>
      client === oldClient ? oldRead.promise : newRead.promise
    )
    await render(oldClient)
    await render(newClient)

    await act(async () => oldRead.reject(new Error('old desktop went away')))
    expect(shownLanguages()).toEqual([])
    expect(JSON.stringify(renderer?.toJSON())).not.toContain('old desktop went away')

    await act(async () => newRead.resolve(cabinetState({ language: 'de' })))
    expect(shownLanguages()).toEqual(['de'])
  })

  it('clears the previous desktop cabinet as soon as the client changes', async () => {
    const oldClient = fakeClient()
    const newRead = deferred<MobileSpeechProvidersState>()
    fetchSpeechProviders.mockImplementation((client: RpcClient) =>
      client === oldClient ? Promise.resolve(cabinetState({ language: 'fr' })) : newRead.promise
    )
    await render(oldClient)
    expect(shownLanguages()).toEqual(['fr'])
    await render(fakeClient())
    expect(shownLanguages()).toEqual([])
  })
})

describe('MobileDictationSetupSheet accessibility', () => {
  it('names the dictation switch for screen readers', async () => {
    fetchSpeechProviders.mockResolvedValue(cabinetState())
    await render(fakeClient())
    const toggle = renderer?.root.findByProps({ accessibilityLabel: 'Dictation enabled' })
    expect(toggle?.props.value).toBe(true)
  })

  it('lets the manage link label wrap beside its chevron', async () => {
    fetchSpeechProviders.mockResolvedValue(cabinetState())
    await render(fakeClient())
    const label = renderer?.root.findByProps({ children: 'Manage providers and API keys' })
    expect(label?.props.style).toMatchObject({ flex: 1 })
    expect(label?.parent?.props.style({ pressed: false })).toEqual(
      expect.arrayContaining([expect.objectContaining({ gap: 8 })])
    )
  })
})

describe('MobileDictationSetupSheet errors', () => {
  it('keeps a failed model select error after a download refreshes the setup', async () => {
    fetchSpeechProviders.mockResolvedValue(null)
    fetchDictationSetup.mockResolvedValue({
      enabled: true,
      dictationMode: 'toggle',
      selectedModelId: '',
      models: [
        { id: 'ready', label: 'Ready', provider: 'local', status: 'ready', sizeBytes: 1 },
        { id: 'fresh', label: 'Fresh', provider: 'local', status: 'not-downloaded', sizeBytes: 1 }
      ]
    })
    setDictationConfig.mockRejectedValue(new Error('Desktop refused the model'))
    downloadDictationModel.mockResolvedValue(undefined)
    await render(fakeClient())

    const useReady = legacyAction('Use')
    await act(async () => useReady?.props.onPress())
    const downloadFresh = legacyAction('Download')
    await act(async () => downloadFresh?.props.onPress())
    expect(fetchDictationSetup).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(renderer?.toJSON())).toContain('Desktop refused the model')
  })
  it('clears a failed read once a model select snapshot lands', async () => {
    const setup = {
      enabled: true,
      dictationMode: 'toggle',
      selectedModelId: '',
      models: [
        { id: 'ready', label: 'Ready', provider: 'local', status: 'ready', sizeBytes: 1 },
        { id: 'fresh', label: 'Fresh', provider: 'local', status: 'not-downloaded', sizeBytes: 1 }
      ]
    }
    fetchSpeechProviders.mockResolvedValue(null)
    fetchDictationSetup
      .mockResolvedValueOnce(setup)
      .mockRejectedValueOnce(new Error('Desktop unreachable'))
    downloadDictationModel.mockResolvedValue(undefined)
    setDictationConfig.mockResolvedValue({ ...setup, selectedModelId: 'ready' })
    await render(fakeClient())

    const downloadFresh = legacyAction('Download')
    await act(async () => downloadFresh?.props.onPress())
    expect(JSON.stringify(renderer?.toJSON())).toContain('Desktop unreachable')
    const useReady = legacyAction('Use')
    await act(async () => useReady?.props.onPress())
    expect(JSON.stringify(renderer?.toJSON())).not.toContain('Desktop unreachable')
  })
})
