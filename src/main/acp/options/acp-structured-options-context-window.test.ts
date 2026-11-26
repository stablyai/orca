import { describe, expect, it } from 'vitest'
import { AcpStructuredOptions } from './acp-structured-options'
import { CURSOR_ACP_DIALECT } from '../acp-dialects/cursor-dialect'

const select = (id: string, category: string, currentValue: string, values: string[]) => ({
  id,
  name: id,
  category,
  type: 'select' as const,
  currentValue,
  options: values.map((value) => ({ value, name: value.toUpperCase() }))
})

const running = (model: string, sizes: string[]) => [
  select('model', 'model', model, ['grok-4.7', 'claude-opus-4-8']),
  select('context', 'model_config', sizes[0]!, sizes)
]

describe('Cursor context window', () => {
  it('writes only a size the running model lists', () => {
    const options = new AcpStructuredOptions(CURSOR_ACP_DIALECT)
    options.adoptSession({ configOptions: running('grok-4.7', ['256k', '500k']) }, 'new')
    expect(options.write('contextWindow', '500k')).toEqual({
      method: 'config',
      configId: 'context',
      value: '500k'
    })
    expect(options.read().current.contextWindow).toBe('256k')

    options.adoptConfigOptions(running('claude-opus-4-8', ['200k', '1m']))
    expect(options.write('contextWindow', '500k')).toBeNull()
    expect(options.read().models.find((model) => model.id === 'claude-opus-4-8')).toMatchObject({
      contextWindows: [
        { value: '200k', label: '200K' },
        { value: '1m', label: '1M' }
      ]
    })
  })
})
