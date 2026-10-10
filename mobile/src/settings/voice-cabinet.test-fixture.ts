import { vi } from 'vitest'
import type {
  MobileSpeechProviderModel,
  MobileSpeechProvidersState
} from '../dictation/speech-provider-reply-schema'
import type { MobileSpeechSetup } from '../dictation/mobile-dictation-setup'
import type { VoiceProviderOperations, VoiceSettingsOperations } from './voice-settings-operations'

function model(
  fields: Pick<MobileSpeechProviderModel, 'id' | 'label' | 'status'> &
    Partial<MobileSpeechProviderModel>
): MobileSpeechProviderModel {
  return {
    description: undefined,
    realtime: false,
    languages: undefined,
    sizeBytes: null,
    recommended: false,
    progress: null,
    ...fields
  }
}

export function cabinetState(
  overrides: Partial<MobileSpeechProvidersState> = {}
): MobileSpeechProvidersState {
  return {
    enabled: true,
    selectedModelId: 'soniox-stt-rt-v5',
    dictationMode: 'toggle',
    language: 'auto',
    providers: [
      {
        id: 'local',
        kind: 'local',
        label: 'On-device',
        description: 'Private models.',
        keyConfigured: false,
        keyHint: null,
        keyUrl: null,
        keyPlaceholder: null,
        models: [
          model({
            id: 'whisper-tiny',
            label: 'Whisper Tiny',
            status: 'ready',
            sizeBytes: 75_000_000
          }),
          model({
            id: 'parakeet',
            label: 'Parakeet',
            status: 'not-downloaded',
            sizeBytes: 600_000_000
          })
        ]
      },
      {
        id: 'soniox',
        kind: 'cloud',
        label: 'Soniox',
        description: 'Real-time streaming.',
        keyConfigured: true,
        keyHint: '…a1b2',
        keyUrl: 'https://console.soniox.com/',
        keyPlaceholder: 'Soniox API key',
        models: [
          model({
            id: 'soniox-stt-rt-v5',
            label: 'Soniox Real-time v5',
            realtime: true,
            status: 'ready'
          })
        ]
      },
      {
        id: 'deepgram',
        kind: 'cloud',
        label: 'Deepgram',
        description: 'Nova-3.',
        keyConfigured: false,
        keyHint: null,
        keyUrl: 'https://console.deepgram.com/',
        keyPlaceholder: 'Deepgram API key',
        models: [
          model({
            id: 'deepgram-nova-3',
            label: 'Nova-3',
            realtime: true,
            status: 'not-downloaded'
          })
        ]
      }
    ],
    ...overrides
  }
}

export const legacySetup: MobileSpeechSetup = {
  enabled: true,
  dictationMode: 'toggle',
  selectedModelId: 'whisper-tiny',
  models: [
    {
      id: 'whisper-tiny',
      label: 'Whisper Tiny',
      provider: 'local',
      status: 'ready',
      sizeBytes: 75_000_000,
      progress: null
    }
  ]
}

export function voiceOperations(providers: Partial<VoiceProviderOperations> | null) {
  const providerOps: VoiceProviderOperations = {
    list: vi.fn().mockResolvedValue(cabinetState()),
    saveKey: vi.fn().mockResolvedValue(cabinetState()),
    clearKey: vi.fn().mockResolvedValue(cabinetState()),
    testKey: vi.fn().mockResolvedValue({ ok: true, message: null }),
    setLanguage: vi.fn().mockResolvedValue(cabinetState()),
    ...providers
  }
  const operations: VoiceSettingsOperations = {
    load: vi.fn().mockResolvedValue(legacySetup),
    configure: vi.fn().mockResolvedValue(legacySetup),
    download: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(legacySetup),
    ...(providers === null ? {} : { providers: providerOps })
  }
  return { operations, providerOps }
}
