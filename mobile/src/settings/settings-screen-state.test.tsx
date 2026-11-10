import { createElement, useEffect, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import VoiceSettingsScreen from './voice-settings-screen'
import type { VoiceSettingsOperations } from './voice-settings-operations'

import { VoiceModelList } from '../components/VoiceModelList'
import type { MobileSpeechModel, MobileSpeechSetup } from '../dictation/mobile-dictation-setup'

vi.mock(
  './settings-screen-frame',
  async () => (await import('../test-support/settings-chrome-test-double')).settingsFrameDouble
)
vi.mock(
  '../components/list/ListGroup',
  async () => (await import('../test-support/settings-chrome-test-double')).listGroupDouble
)
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  AppState: { addEventListener: () => ({ remove() {} }) }
}))
vi.mock('../components/MobileSwitch', () => ({ MobileSwitch: 'Switch' }))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 })
}))
vi.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void) => useEffect(callback, [callback])
}))
vi.mock('lucide-react-native', () => ({ ChevronLeft: 'Icon', ChevronRight: 'Icon' }))
vi.mock('../components/bottom-drawer/BottomDrawer', () => ({
  BottomDrawer: ({ children }: { children: ReactNode }) => children
}))
vi.mock('../components/VoiceModelList', () => ({ VoiceModelList: () => null }))
vi.mock('./voice-transcribe-on-section', () => ({
  VoiceTranscribeOnSection: () => null,
  voiceTranscribeOnShown: () => false
}))
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
  it('shows a desktop on Auto as Auto and switches it to plain Toggle', async () => {
    const operations: VoiceSettingsOperations = {
      load: vi.fn<VoiceSettingsOperations['load']>().mockResolvedValue({
        enabled: true,
        dictationMode: 'toggle',
        dictationHoldToRecord: true,
        selectedModelId: '',
        models: []
      }),
      configure: vi.fn<VoiceSettingsOperations['configure']>(() => new Promise(() => {})),
      download: vi.fn(),
      delete: vi.fn()
    }
    await act(async () => {
      renderer = create(
        createElement(VoiceSettingsScreen, { operations, focused: true, onBack: vi.fn() })
      )
    })
    const modeProps = () => renderer.root.findByProps({ testIDPrefix: 'voice-mode-' }).props
    expect(modeProps().selected).toBe('auto')

    await act(async () => {
      modeProps().onSelect('toggle')
    })
    expect(operations.configure).toHaveBeenCalledWith({
      dictationMode: 'toggle',
      dictationHoldToRecord: false
    })
    expect(modeProps().selected).toBe('toggle')
  })
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
  it('keeps the latest Voice switch choice while an older save replies', async () => {
    const loaded = {
      enabled: true,
      dictationMode: 'toggle',
      selectedModelId: '',
      models: []
    }
    const replies: ((value: typeof loaded) => void)[] = []
    const operations: VoiceSettingsOperations = {
      load: vi.fn().mockResolvedValue(loaded),
      configure: vi.fn(() => new Promise<typeof loaded>((resolve) => replies.push(resolve))),
      download: vi.fn(),
      delete: vi.fn()
    }
    await act(async () => {
      renderer = create(
        createElement(VoiceSettingsScreen, { operations, focused: true, onBack: vi.fn() })
      )
    })
    const switchProps = () => renderer.root.findByProps({ testID: 'voice-enabled' }).props
    await act(async () => {
      switchProps().onValueChange(false)
    })
    await act(async () => {
      switchProps().onValueChange(true)
    })
    await act(async () => {
      replies[0]({ ...loaded, enabled: false })
    })
    expect(switchProps().value).toBe(true)
    await act(async () => {
      replies[1]({ ...loaded, enabled: true })
    })
    expect(switchProps().value).toBe(true)
  })
  describe('a model delete', () => {
    const model: MobileSpeechModel = {
      id: 'base',
      label: 'Base',
      provider: 'local',
      sizeBytes: null,
      recommended: true,
      status: 'ready',
      progress: null
    }
    const selected: MobileSpeechSetup = {
      enabled: true,
      dictationMode: 'toggle',
      selectedModelId: 'base',
      models: [model]
    }
    const deleted: MobileSpeechSetup = {
      ...selected,
      selectedModelId: '',
      models: [{ ...model, status: 'not-downloaded' }]
    }
    async function deleteThenChangeMode() {
      const pendingDelete = Promise.withResolvers<MobileSpeechSetup>()
      const reads: (() => void)[] = []
      const operations: VoiceSettingsOperations = {
        load: vi
          .fn()
          .mockResolvedValueOnce(selected)
          .mockImplementation(
            () => new Promise<MobileSpeechSetup>((resolve) => reads.push(() => resolve(deleted)))
          ),
        configure: vi.fn().mockResolvedValue({ ...selected, dictationMode: 'hold' }),
        download: vi.fn(),
        delete: vi.fn(() => pendingDelete.promise)
      }
      await act(async () => {
        renderer = create(
          createElement(VoiceSettingsScreen, { operations, focused: true, onBack: vi.fn() })
        )
      })
      await act(async () => {
        renderer.root.findByType(VoiceModelList).props.onDelete(model)
      })
      await act(async () => {
        renderer.root.findByProps({ testIDPrefix: 'voice-mode-' }).props.onSelect('hold')
      })
      const finishReads = async () => {
        expect(reads.length).toBeGreaterThan(0)
        await act(async () => {
          reads.forEach((finishRead) => finishRead())
        })
      }
      return { pendingDelete, finishReads }
    }
    it('re-reads when it succeeds after a newer change replied', async () => {
      const { pendingDelete, finishReads } = await deleteThenChangeMode()
      await act(async () => {
        pendingDelete.resolve(deleted)
      })
      await finishReads()
      expect(renderer.root.findByType(VoiceModelList).props.setup.selectedModelId).toBe('')
    })
    it('keeps its error through the re-read when it fails after a newer change', async () => {
      const { pendingDelete, finishReads } = await deleteThenChangeMode()
      await act(async () => {
        pendingDelete.reject(new Error('voice_model_in_use'))
      })
      await finishReads()
      expect(JSON.stringify(renderer.toJSON())).toContain('voice_model_in_use')
    })
    it('waits for it before re-reading for an older save', async () => {
      let deleteFinished = false
      const reads: (() => void)[] = []
      const pendingSave = Promise.withResolvers<MobileSpeechSetup>()
      const pendingDelete = Promise.withResolvers<MobileSpeechSetup>()
      const operations: VoiceSettingsOperations = {
        load: vi
          .fn()
          .mockResolvedValueOnce(selected)
          .mockImplementation(() => {
            const snapshot = deleteFinished ? deleted : selected
            return new Promise<MobileSpeechSetup>((resolve) => reads.push(() => resolve(snapshot)))
          }),
        configure: vi.fn(() => pendingSave.promise),
        download: vi.fn(),
        delete: vi.fn(() => pendingDelete.promise)
      }
      await act(async () => {
        renderer = create(
          createElement(VoiceSettingsScreen, { operations, focused: true, onBack: vi.fn() })
        )
      })
      await act(async () => {
        renderer.root.findByProps({ testIDPrefix: 'voice-mode-' }).props.onSelect('hold')
      })
      await act(async () => {
        renderer.root.findByType(VoiceModelList).props.onDelete(model)
      })
      await act(async () => {
        pendingSave.resolve({ ...selected, dictationMode: 'hold' })
      })
      await act(async () => {
        deleteFinished = true
        pendingDelete.resolve(deleted)
      })
      await act(async () => {
        reads.forEach((finishRead) => finishRead())
      })
      expect(renderer.root.findByType(VoiceModelList).props.setup.selectedModelId).toBe('')
    })
  })
})
