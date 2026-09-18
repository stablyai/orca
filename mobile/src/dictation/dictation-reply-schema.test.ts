import { describe, expect, it } from 'vitest'
import {
  dictationSetupSchema,
  SPEECH_MODEL_PROVIDERS,
  SPEECH_MODEL_STATUSES
} from './dictation-reply-schema'

const setup = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  selectedModelId: 'm1',
  dictationMode: 'toggle',
  models: [],
  ...overrides
})

describe('dictation setup reply schema', () => {
  it('requires the model list the sheet maps unguarded', () => {
    const { models: _models, ...withoutModels } = setup()
    expect(dictationSetupSchema.safeParse(withoutModels).success).toBe(false)
    expect(dictationSetupSchema.safeParse(setup({ models: 'none' })).success).toBe(false)
  })

  it('forwards a dictation mode this build has never heard of instead of substituting one', () => {
    expect(dictationSetupSchema.parse(setup({ dictationMode: 'push-to-talk' })).dictationMode).toBe(
      'push-to-talk'
    )
    expect(dictationSetupSchema.parse(setup({ dictationMode: 'hold' })).dictationMode).toBe('hold')
  })

  it('keeps a sheet whose mode is absent or unreadable, which main rendered', () => {
    const { dictationMode: _mode, ...withoutMode } = setup()
    expect(dictationSetupSchema.parse(withoutMode).dictationMode).toBeUndefined()
    expect(dictationSetupSchema.parse(setup({ dictationMode: 3 })).dictationMode).toBeUndefined()
  })

  it('salvages enabled and selectedModelId onto the off-and-unselected sheet main drew', () => {
    const parsed = dictationSetupSchema.parse(setup({ enabled: 'yes', selectedModelId: 4 }))
    expect(parsed.enabled).toBeUndefined()
    expect(parsed.selectedModelId).toBeUndefined()
  })

  it('drops a model row the sheet could not address or send back', () => {
    const parsed = dictationSetupSchema.parse(
      setup({ models: [{ id: 'a', label: 'A' }, { label: 'B' }, { id: 'c' }] })
    )
    expect(parsed.models.map((model) => model.id)).toEqual(['a', 'c'])
  })

  it('degrades an unknown provider or status arm to absent and keeps the row', () => {
    const [model] = dictationSetupSchema.parse(
      setup({ models: [{ id: 'a', provider: 'anthropic', status: 'verifying' }] })
    ).models
    expect(model?.id).toBe('a')
    expect(model?.provider).toBeUndefined()
    expect(model?.status).toBeUndefined()
  })

  it('keeps the known provider and status arms', () => {
    const [model] = dictationSetupSchema.parse(
      setup({ models: [{ id: 'a', provider: 'openai', status: 'extracting' }] })
    ).models
    expect(model?.provider).toBe('openai')
    expect(model?.status).toBe('extracting')
  })

  it('salvages a row member behind main own guard and keeps the truthy recommended flag', () => {
    const [model] = dictationSetupSchema.parse(
      setup({ models: [{ id: 'a', sizeBytes: 'big', progress: 'half', recommended: 1 }] })
    ).models
    expect(model?.sizeBytes).toBeUndefined()
    expect(model?.progress).toBeUndefined()
    expect(model?.recommended).toBe(1)
  })

  it('keeps an explicit null size and progress, which the host sends for an API model', () => {
    const [model] = dictationSetupSchema.parse(
      setup({ models: [{ id: 'a', sizeBytes: null, progress: null }] })
    ).models
    expect(model?.sizeBytes).toBeNull()
    expect(model?.progress).toBeNull()
  })

  it('passes a newer host member through', () => {
    expect(dictationSetupSchema.parse(setup({ hotword: 'orca' }))).toMatchObject({
      hotword: 'orca'
    })
  })
})

describe('provider and status are closed over the host union', () => {
  // The arm lists are pinned to RuntimeSpeechModelSummary in the schema module, where tsc looks;
  // this loop proves every pinned arm survives the parse, not just the two the tests above pick.
  it('keeps every arm the host declares, so nothing it sends today degrades', () => {
    for (const provider of SPEECH_MODEL_PROVIDERS) {
      for (const status of SPEECH_MODEL_STATUSES) {
        const [model] = dictationSetupSchema.parse(
          setup({ models: [{ id: 'a', provider, status }] })
        ).models
        expect(model).toMatchObject({ provider, status })
      }
    }
  })
})
