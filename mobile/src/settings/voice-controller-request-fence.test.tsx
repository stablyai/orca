import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useVoiceSettingsController } from './use-voice-settings-controller'
import { useVoiceProviderController } from './use-voice-provider-controller'
import { cabinetState, legacySetup, voiceOperations } from './voice-cabinet.test-fixture'
import type { VoiceSettingsOperations } from './voice-settings-operations'
import type { MobileSpeechProvidersState } from '../dictation/speech-provider-reply-schema'
import type { MobileSpeechSetup } from '../dictation/mobile-dictation-setup'

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) }
}))

let renderer: ReactTestRenderer | undefined

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
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

type SettingsController = ReturnType<typeof useVoiceSettingsController>
type ProviderController = ReturnType<typeof useVoiceProviderController>

function mountHook<T>(useHook: (operations: VoiceSettingsOperations) => T) {
  const latest: { current: T | null } = { current: null }
  function Harness({ operations }: { operations: VoiceSettingsOperations }) {
    latest.current = useHook(operations)
    return null
  }
  return {
    latest,
    async render(operations: VoiceSettingsOperations) {
      await act(async () => {
        if (renderer) {
          renderer.update(createElement(Harness, { operations }))
        } else {
          renderer = create(createElement(Harness, { operations }))
        }
      })
    }
  }
}

function current<T>(latest: { current: T | null }): T {
  if (!latest.current) {
    throw new Error('hook did not render')
  }
  return latest.current
}

describe('voice settings controller request fencing', () => {
  it('ignores a slow read from the previous desktop after the client changes', async () => {
    const oldList = deferred<MobileSpeechProvidersState>()
    const newList = deferred<MobileSpeechProvidersState>()
    const oldHost = voiceOperations({ list: vi.fn().mockReturnValue(oldList.promise) })
    const newHost = voiceOperations({ list: vi.fn().mockReturnValue(newList.promise) })
    const hook = mountHook((ops) => useVoiceSettingsController(ops, true))
    await hook.render(oldHost.operations)
    await hook.render(newHost.operations)

    await act(async () => oldList.resolve(cabinetState({ language: 'fr' })))
    expect(current<SettingsController>(hook.latest).cabinet).toBeNull()
    await act(async () => newList.resolve(cabinetState({ language: 'de' })))
    expect(current<SettingsController>(hook.latest).cabinet?.language).toBe('de')
  })

  it('drops a configure reply and error from the previous desktop', async () => {
    const slowConfigure = deferred<never>()
    const oldHost = voiceOperations({})
    oldHost.operations.configure = vi.fn().mockReturnValue(slowConfigure.promise)
    const newHost = voiceOperations({})
    const hook = mountHook((ops) => useVoiceSettingsController(ops, true))
    await hook.render(oldHost.operations)
    await act(
      async () => void current<SettingsController>(hook.latest).configure({ enabled: false })
    )
    await hook.render(newHost.operations)

    await act(async () => slowConfigure.reject(new Error('old desktop failed')))
    expect(current<SettingsController>(hook.latest).error).toBeNull()
    expect(current<SettingsController>(hook.latest).cabinet?.enabled).toBe(true)
  })

  it('keeps the newer write when an older configure answers last', async () => {
    const first = deferred<MobileSpeechSetup>()
    const { operations, providerOps } = voiceOperations({})
    operations.configure = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({
      enabled: true,
      dictationMode: 'hold',
      selectedModelId: '',
      models: []
    })
    const hook = mountHook((ops) => useVoiceSettingsController(ops, true))
    await hook.render(operations)
    await act(async () => {
      void current<SettingsController>(hook.latest).configure({ dictationMode: 'toggle' })
      void current<SettingsController>(hook.latest).configure({ dictationMode: 'hold' })
    })
    // Why: the superseded snapshot triggers a re-read; the desktop holds the newer write.
    providerOps.list = vi.fn().mockResolvedValue(cabinetState({ dictationMode: 'hold' }))
    await act(async () =>
      first.resolve({ enabled: true, dictationMode: 'toggle', selectedModelId: '', models: [] })
    )
    expect(providerOps.list).toHaveBeenCalledOnce()
    expect(current<SettingsController>(hook.latest).cabinet?.dictationMode).toBe('hold')
  })

  it('clears the previous desktop state and drawers as soon as the client changes', async () => {
    const pendingList = deferred<MobileSpeechProvidersState>()
    const oldHost = voiceOperations({})
    const newHost = voiceOperations({ list: vi.fn().mockReturnValue(pendingList.promise) })
    const hook = mountHook((ops) => useVoiceSettingsController(ops, true))
    await hook.render(oldHost.operations)
    await act(async () => current<SettingsController>(hook.latest).setModelDrawerOpen(true))
    await act(async () => current<SettingsController>(hook.latest).setLanguageDrawerOpen(true))
    expect(current<SettingsController>(hook.latest).cabinet).not.toBeNull()

    await hook.render(newHost.operations)
    const controller = current<SettingsController>(hook.latest)
    expect(controller.cabinet).toBeNull()
    expect(controller.loading).toBe(true)
    expect(controller.modelDrawerOpen).toBe(false)
    expect(controller.languageDrawerOpen).toBe(false)
  })

  it('drops an older configure failure that lands after a newer write succeeded', async () => {
    const first = deferred<MobileSpeechSetup>()
    const { operations } = voiceOperations({})
    operations.configure = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ ...legacySetup, dictationMode: 'hold' })
    const hook = mountHook((ops) => useVoiceSettingsController(ops, true))
    await hook.render(operations)
    await act(async () => {
      void current<SettingsController>(hook.latest).configure({ dictationMode: 'toggle' })
      void current<SettingsController>(hook.latest).configure({ dictationMode: 'hold' })
    })
    await act(async () => first.reject(new Error('stale failure')))
    expect(current<SettingsController>(hook.latest).error).toBeNull()
    expect(current<SettingsController>(hook.latest).cabinet?.dictationMode).toBe('hold')
  })

  it('closes the model drawer when the cabinet selected model is deleted', async () => {
    const { operations } = voiceOperations({
      list: vi.fn().mockResolvedValue(cabinetState({ selectedModelId: 'whisper-tiny' }))
    })
    const hook = mountHook((ops) => useVoiceSettingsController(ops, true))
    await hook.render(operations)
    expect(current<SettingsController>(hook.latest).setup).toBeNull()
    await act(async () => current<SettingsController>(hook.latest).setModelDrawerOpen(true))
    await act(async () => current<SettingsController>(hook.latest).deleteModel('whisper-tiny'))
    expect(current<SettingsController>(hook.latest).modelDrawerOpen).toBe(false)
  })
})

describe('voice provider controller request fencing', () => {
  it('drops a key test verdict that finishes after the key was replaced', async () => {
    const slowTest = deferred<{ ok: boolean; message: string | null }>()
    const { operations } = voiceOperations({ testKey: vi.fn().mockReturnValue(slowTest.promise) })
    const hook = mountHook((ops) => useVoiceProviderController(ops, true))
    await hook.render(operations)
    await act(async () => void current<ProviderController>(hook.latest).testKey('soniox'))
    await act(async () => current<ProviderController>(hook.latest).saveKey('soniox', 'new-key'))
    expect(current<ProviderController>(hook.latest).testResult).toEqual({ ok: true, message: null })

    await act(async () => slowTest.resolve({ ok: false, message: 'Old key rejected (401).' }))
    expect(current<ProviderController>(hook.latest).testResult).toEqual({ ok: true, message: null })
  })

  it('keeps the new desktop key spinner when the old desktop save settles', async () => {
    const oldSave = deferred<MobileSpeechProvidersState>()
    const newSave = deferred<MobileSpeechProvidersState>()
    const oldHost = voiceOperations({ saveKey: vi.fn().mockReturnValue(oldSave.promise) })
    const newHost = voiceOperations({ saveKey: vi.fn().mockReturnValue(newSave.promise) })
    const hook = mountHook((ops) => useVoiceProviderController(ops, true))
    await hook.render(oldHost.operations)
    await act(async () => current<ProviderController>(hook.latest).openKeyDrawer())
    await act(async () => void current<ProviderController>(hook.latest).saveKey('deepgram', 'a'))
    await hook.render(newHost.operations)
    expect(current<ProviderController>(hook.latest).keyDrawerOpen).toBe(false)
    expect(current<ProviderController>(hook.latest).keyAction).toBeNull()

    await act(async () => void current<ProviderController>(hook.latest).saveKey('deepgram', 'b'))
    await act(async () => oldSave.reject(new Error('old desktop failed')))
    const controller = current<ProviderController>(hook.latest)
    expect(controller.keyAction).toBe('saving')
    expect(controller.keyError).toBeNull()
  })

  it('drops an older key save failure once a newer key change was made', async () => {
    const slowSave = deferred<MobileSpeechProvidersState>()
    const { operations } = voiceOperations({ saveKey: vi.fn().mockReturnValue(slowSave.promise) })
    const hook = mountHook((ops) => useVoiceProviderController(ops, true))
    await hook.render(operations)
    await act(async () => void current<ProviderController>(hook.latest).saveKey('deepgram', 'a'))
    await act(async () => current<ProviderController>(hook.latest).removeKey('deepgram'))
    await act(async () => slowSave.reject(new Error('stale failure')))
    const controller = current<ProviderController>(hook.latest)
    expect(controller.keyError).toBeNull()
    expect(controller.keyAction).toBeNull()
  })

  it('ignores a key save that the previous desktop answers after the client changes', async () => {
    const slowSave = deferred<MobileSpeechProvidersState>()
    const oldHost = voiceOperations({ saveKey: vi.fn().mockReturnValue(slowSave.promise) })
    const newHost = voiceOperations({
      list: vi.fn().mockResolvedValue(cabinetState({ language: 'de' }))
    })
    const hook = mountHook((ops) => useVoiceProviderController(ops, true))
    await hook.render(oldHost.operations)
    await act(async () => void current<ProviderController>(hook.latest).saveKey('deepgram', 'k'))
    await hook.render(newHost.operations)

    await act(async () => slowSave.resolve(cabinetState({ language: 'fr' })))
    const controller = current<ProviderController>(hook.latest)
    expect(controller.state?.language).toBe('de')
    expect(controller.testResult).toBeNull()
  })
})

describe('voice request fence scopes', () => {
  it('keeps a key save error while a model select is in flight', async () => {
    const slowSave = deferred<MobileSpeechProvidersState>()
    const slowSelect = deferred<MobileSpeechSetup>()
    const { operations } = voiceOperations({ saveKey: vi.fn().mockReturnValue(slowSave.promise) })
    operations.configure = vi.fn().mockReturnValue(slowSelect.promise)
    const hook = mountHook((ops) => useVoiceProviderController(ops, true))
    await hook.render(operations)
    await act(async () => current<ProviderController>(hook.latest).openKeyDrawer())
    await act(async () => void current<ProviderController>(hook.latest).saveKey('deepgram', 'k'))
    await act(async () => void current<ProviderController>(hook.latest).selectModel('whisper-tiny'))

    await act(async () => slowSave.reject(new Error('Key rejected (401).')))
    expect(current<ProviderController>(hook.latest).keyError).toBe('Key rejected (401).')
    expect(current<ProviderController>(hook.latest).keyDrawerOpen).toBe(true)
  })

  it('closes the key drawer when the save succeeds after a model select started', async () => {
    const slowSave = deferred<MobileSpeechProvidersState>()
    const { operations } = voiceOperations({ saveKey: vi.fn().mockReturnValue(slowSave.promise) })
    operations.configure = vi.fn().mockReturnValue(new Promise(() => {}))
    const hook = mountHook((ops) => useVoiceProviderController(ops, true))
    await hook.render(operations)
    await act(async () => current<ProviderController>(hook.latest).openKeyDrawer())
    await act(async () => void current<ProviderController>(hook.latest).saveKey('deepgram', 'k'))
    await act(async () => void current<ProviderController>(hook.latest).selectModel('whisper-tiny'))

    await act(async () => slowSave.resolve(cabinetState({ language: 'fr' })))
    const controller = current<ProviderController>(hook.latest)
    expect(controller.keyDrawerOpen).toBe(false)
    expect(controller.testResult).toEqual({ ok: true, message: null })
    expect(controller.state?.language).toBe('fr')
  })

  it('shows a download failure while a model select is in flight', async () => {
    const slowDownload = deferred<void>()
    const { operations } = voiceOperations({})
    operations.download = vi.fn().mockReturnValue(slowDownload.promise)
    operations.configure = vi.fn().mockReturnValue(new Promise(() => {}))
    const hook = mountHook((ops) => useVoiceSettingsController(ops, true))
    await hook.render(operations)
    await act(async () => void current<SettingsController>(hook.latest).downloadModel('parakeet'))
    await act(async () => void current<SettingsController>(hook.latest).selectModel('whisper-tiny'))

    await act(async () => slowDownload.reject(new Error('Disk full')))
    expect(current<SettingsController>(hook.latest).error).toBe('Disk full')
  })

  it('does not let an older snapshot overwrite a newer write that already landed', async () => {
    const slowSelect = deferred<MobileSpeechSetup>()
    const { operations, providerOps } = voiceOperations({})
    operations.configure = vi.fn().mockReturnValue(slowSelect.promise)
    operations.delete = vi.fn().mockResolvedValue({ ...legacySetup, selectedModelId: 'parakeet' })
    const hook = mountHook((ops) => useVoiceSettingsController(ops, true))
    await hook.render(operations)
    await act(async () => void current<SettingsController>(hook.latest).selectModel('whisper-tiny'))
    await act(async () => current<SettingsController>(hook.latest).deleteModel('other'))
    expect(current<SettingsController>(hook.latest).cabinet?.selectedModelId).toBe('parakeet')
    // Why: the stale snapshot triggers a re-read; holding it open isolates the snapshot fence.
    providerOps.list = vi.fn().mockReturnValue(new Promise(() => {}))

    await act(async () => slowSelect.resolve({ ...legacySetup, selectedModelId: 'whisper-tiny' }))
    expect(current<SettingsController>(hook.latest).cabinet?.selectedModelId).toBe('parakeet')
  })

  it('re-reads the desktop when a still-current write loses its snapshot to a newer one', async () => {
    const slowSelect = deferred<MobileSpeechSetup>()
    const { operations, providerOps } = voiceOperations({})
    operations.configure = vi.fn().mockReturnValue(slowSelect.promise)
    operations.delete = vi.fn().mockResolvedValue({ ...legacySetup, selectedModelId: 'parakeet' })
    const hook = mountHook((ops) => useVoiceSettingsController(ops, true))
    await hook.render(operations)
    await act(async () => void current<SettingsController>(hook.latest).selectModel('whisper-tiny'))
    await act(async () => current<SettingsController>(hook.latest).deleteModel('other'))
    expect(providerOps.list).toHaveBeenCalledTimes(1)

    providerOps.list = vi.fn().mockResolvedValue(cabinetState({ selectedModelId: 'whisper-tiny' }))
    await act(async () => slowSelect.resolve({ ...legacySetup, selectedModelId: 'whisper-tiny' }))
    expect(providerOps.list).toHaveBeenCalledOnce()
    expect(current<SettingsController>(hook.latest).cabinet?.selectedModelId).toBe('whisper-tiny')
  })

  it('re-reads the desktop when an older write lands after a newer same-scope write failed', async () => {
    const slowSave = deferred<MobileSpeechProvidersState>()
    const { operations, providerOps } = voiceOperations({
      saveKey: vi.fn().mockReturnValue(slowSave.promise),
      clearKey: vi.fn().mockRejectedValue(new Error('Keychain locked'))
    })
    const hook = mountHook((ops) => useVoiceProviderController(ops, true))
    await hook.render(operations)
    await act(async () => void current<ProviderController>(hook.latest).saveKey('deepgram', 'k'))
    await act(async () => current<ProviderController>(hook.latest).removeKey('deepgram'))
    expect(providerOps.list).toHaveBeenCalledTimes(1)

    providerOps.list = vi.fn().mockResolvedValue(cabinetState({ language: 'host-reread' }))
    await act(async () => slowSave.resolve(cabinetState({ language: 'stale-snapshot' })))
    expect(providerOps.list).toHaveBeenCalledOnce()
    expect(current<ProviderController>(hook.latest).state?.language).toBe('host-reread')
  })
})
