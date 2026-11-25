import { describe, expect, it } from 'vitest'
import { dictationSetupSchema } from './dictation-reply-schema'
import { cloudModelServiceLabel } from './mobile-dictation-setup'

function readModels(models: unknown[]) {
  return dictationSetupSchema.parse({ enabled: true, selectedModelId: '', models }).models
}

describe('cloud model service', () => {
  it('names Soniox for a Soniox model', () => {
    const [model] = readModels([
      { id: 'soniox-stt-rt', provider: 'openai', cloudService: 'soniox' }
    ])
    expect(cloudModelServiceLabel(model)).toBe('Soniox')
  })

  it('keeps the OpenAI label for hosts that send no service', () => {
    const [model] = readModels([{ id: 'openai-gpt-transcribe', provider: 'openai' }])
    expect(model.cloudService).toBeUndefined()
    expect(cloudModelServiceLabel(model)).toBe('OpenAI API')
  })

  it('drops a malformed service without losing the row', () => {
    const [model] = readModels([{ id: 'x', provider: 'openai', cloudService: 42 }])
    expect(model.id).toBe('x')
    expect(cloudModelServiceLabel(model)).toBe('OpenAI API')
  })
})
