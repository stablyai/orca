import { describe, expect, it } from 'vitest'
import { acpListedModels, acpSelectChoices } from './acp-select-choices'
import type { SessionConfigOption } from '../generated/acp-protocol.generated'

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>

function modelSelect(options: SelectOption['options']): SelectOption {
  return {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: '["deepseek-official","deepseek-v4-flash"]',
    options
  }
}

describe('ACP model menu: grouped model selects', () => {
  it('names the provider on a model name two providers both offer', () => {
    const models = acpListedModels(
      modelSelect([
        {
          group: 'deepseek-official',
          name: 'DeepSeek',
          options: [
            { value: '["deepseek-official","deepseek-v4-flash"]', name: 'deepseek-v4-flash' },
            { value: '["deepseek-official","deepseek-v4-pro"]', name: 'DeepSeek-V4-Pro' }
          ]
        },
        {
          group: 'deepseek-account',
          name: 'DeepSeek Account',
          options: [
            { value: '["deepseek-account","deepseek-flash"]', name: 'DeepSeek-V4.1-Flash' },
            { value: '["deepseek-account","deepseek-v4-pro"]', name: 'DeepSeek-V4-Pro' }
          ]
        }
      ]),
      null
    )

    expect(models).toEqual([
      { id: '["deepseek-official","deepseek-v4-flash"]', label: 'deepseek-v4-flash' },
      { id: '["deepseek-official","deepseek-v4-pro"]', label: 'DeepSeek-V4-Pro (DeepSeek)' },
      { id: '["deepseek-account","deepseek-flash"]', label: 'DeepSeek-V4.1-Flash' },
      { id: '["deepseek-account","deepseek-v4-pro"]', label: 'DeepSeek-V4-Pro (DeepSeek Account)' }
    ])
  })

  it('leaves labels alone when no name repeats', () => {
    const models = acpListedModels(
      modelSelect([
        { value: 'gpt-6', name: 'GPT-6' },
        { value: 'gpt-6-mini', name: 'GPT-6 mini', description: 'Faster replies.' }
      ]),
      null
    )

    expect(models).toEqual([
      { id: 'gpt-6', label: 'GPT-6' },
      { id: 'gpt-6-mini', label: 'GPT-6 mini', description: 'Faster replies.' }
    ])
    expect(acpSelectChoices(modelSelect([{ value: 'gpt-6', name: 'GPT-6' }]))).toEqual([
      { value: 'gpt-6', name: 'GPT-6' }
    ])
  })
})
