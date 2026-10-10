import { describe, expect, it } from 'vitest'
import {
  isLanguageSupported,
  speechModelLanguageSupport,
  transcriptionLanguageSummary
} from './speech-provider-presentation'
import { cabinetState } from '../settings/voice-cabinet.test-fixture'
import type {
  MobileSpeechProviderModel,
  MobileSpeechProvidersState
} from './speech-provider-reply-schema'

function bareModel(languages: string[] | null | undefined): MobileSpeechProviderModel {
  return {
    id: 'm',
    label: 'Model',
    description: undefined,
    realtime: false,
    languages,
    sizeBytes: null,
    recommended: false,
    status: 'ready',
    progress: null
  }
}

function withModelLanguages(
  languages: string[] | null | undefined,
  language: string
): MobileSpeechProvidersState {
  const state = cabinetState({ language })
  return {
    ...state,
    providers: state.providers.map((provider) => ({
      ...provider,
      models: provider.models.map((model) =>
        model.id === state.selectedModelId ? { ...model, languages } : model
      )
    }))
  }
}

describe('speech model language support', () => {
  it('treats a model that picks its own language as ignoring hints', () => {
    const support = speechModelLanguageSupport(bareModel(null))
    expect(support).toEqual({ kind: 'model-picks' })
    expect(isLanguageSupported(support, 'uk')).toBe(false)
    expect(isLanguageSupported(support, 'auto')).toBe(true)
  })

  it('offers every language when an older desktop does not report support', () => {
    expect(isLanguageSupported(speechModelLanguageSupport(bareModel(undefined)), 'uk')).toBe(true)
  })

  it('summarises what dictation will actually do with the selected model', () => {
    expect(transcriptionLanguageSummary(withModelLanguages(['en', 'uk'], 'uk'))).toBe('Ukrainian')
    expect(transcriptionLanguageSummary(withModelLanguages(['en', 'de'], 'uk'))).toBe(
      'Ukrainian not supported here · auto-detect'
    )
    expect(transcriptionLanguageSummary(withModelLanguages(null, 'uk'))).toBe(
      'Detected by Soniox Real-time v5'
    )
    expect(transcriptionLanguageSummary(withModelLanguages(['en'], 'auto'))).toBe('Auto-detect')
  })
})
