import { expect, it } from 'vitest'
import { AcpStructuredOptions } from './acp-structured-options'
import { OMP_ACP_DIALECT } from '../acp-dialects/omp-dialect'

it('uses native family selections and choices when switching models without another report', () => {
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
    models: [
      {
        id: 'openai/gpt-4.1',
        serviceTier: 'priority',
        serviceTiers: [
          { value: 'none', label: 'None' },
          { value: 'default', label: 'Default' },
          { value: 'flex', label: 'Flex' },
          { value: 'priority', label: 'Priority' }
        ]
      },
      { id: 'custom/qwen', serviceTier: null, serviceTiers: [] },
      {
        id: 'google/gemini',
        serviceTier: 'flex',
        serviceTiers: [
          { value: 'none', label: 'None' },
          { value: 'flex', label: 'Flex' },
          { value: 'priority', label: 'Priority' }
        ]
      }
    ]
  })
  expect(options.write('serviceTier', 'default')).toEqual({
    method: 'command',
    text: '/orca-service-tier default'
  })
  expect(options.write('serviceTier', 'none')).toEqual({
    method: 'command',
    text: '/orca-service-tier none'
  })
  expect(options.write('serviceTier', 'flex')).toEqual({
    method: 'command',
    text: '/orca-service-tier flex'
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
  expect(options.read().current.serviceTier).toBe('flex')
  expect(options.write('serviceTier', 'default')).toBeNull()
})
