import { expect, it } from 'vitest'
import { AcpStructuredOptions } from './acp-structured-options'
import { OMP_ACP_DIALECT } from '../acp-dialects/omp-dialect'

it('uses the newly selected model capability before OMP reports its service tier again', () => {
  const options = new AcpStructuredOptions(OMP_ACP_DIALECT)
  const config = (model: string) => [
    {
      id: 'model',
      name: 'Model',
      category: 'model' as const,
      type: 'select' as const,
      currentValue: model,
      options: [
        { value: 'openai/gpt-4.1', name: 'GPT' },
        { value: 'custom/qwen', name: 'Qwen' },
        { value: 'google/gemini', name: 'Gemini' }
      ]
    }
  ]
  options.adoptSession({ configOptions: config('openai/gpt-4.1') })
  options.adoptServiceTiers({
    model: 'openai/gpt-4.1',
    serviceTier: 'priority',
    models: [
      { id: 'openai/gpt-4.1', priority: true, family: 'openai' },
      { id: 'custom/qwen', priority: false, family: null },
      { id: 'google/gemini', priority: true, family: 'google' }
    ]
  })
  options.adoptConfigOptions(config('custom/qwen'))
  expect(options.write('serviceTier', 'priority')).toBeNull()
  expect(options.read().current.serviceTier).toBeUndefined()
  expect(options.read().models.find((model) => model.id === 'custom/qwen')?.serviceTiers).toEqual(
    []
  )

  options.adoptConfigOptions(config('google/gemini'))
  expect(options.write('serviceTier', 'priority')).toEqual({
    method: 'command',
    text: '/orca-service-tier priority'
  })
  expect(options.read().current.confirmed).not.toContain('serviceTier')
})
