import { describe, expect, it } from 'vitest'
import { dictationSetupSchema } from './dictation-reply-schema'
import { dictationModelRowAction } from './mobile-dictation-setup'

describe('subscription dictation model actions', () => {
  it('routes an unready host subscription model to login recovery', () => {
    const { models } = dictationSetupSchema.parse({
      models: [
        { id: 'chatgpt-subscription-transcribe', provider: 'chatgpt', status: 'not-downloaded' }
      ]
    })

    expect(dictationModelRowAction(models[0]!, '')).toBe('needs-subscription-login')
  })
})
