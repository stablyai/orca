import { describe, expect, it } from 'vitest'
import type { SessionConfigOption } from '../generated/acp-protocol.generated'
import { normalizeMcodeConfigOptions } from './mcode-dialect'

/** Returns the select option named `id`, failing the test when the normalizer dropped it. */
function selectWith(options: SessionConfigOption[], id: string) {
  const found = options.find((option) => option.type === 'select' && option.id === id)
  if (found?.type !== 'select') {
    throw new Error(`missing select option ${id}`)
  }
  return found
}

const modelSelect = (currentValue: string): SessionConfigOption => ({
  type: 'select',
  id: 'model',
  name: 'Model',
  category: 'model',
  currentValue,
  options: [
    { value: 'm:minimax:MiniMax-M3:v:', name: 'M3' },
    { value: 'm:minimax:MiniMax-M3:v:thinking', name: 'M3 · thinking' },
    { value: 'm:minimax:MiniMax-M3.1-Flash:v:', name: 'M3.1-Flash' },
    { value: 'm:minimax:MiniMax-M3.1-Flash:v:thinking', name: 'M3.1-Flash · thinking' },
    { value: 'm:minimax:MiniMax-M3.1-Flash-Preview:v:thinking', name: 'M3.1-Flash-Preview' },
    { value: 'm:custom_provider:minimax-legacy:MiniMax-M2.7:v:thinking', name: 'M2.7 legacy' }
  ]
})

describe('normalizeMcodeConfigOptions', () => {
  it('keeps every configured model with canonical names and injects an on/off menu when absent', () => {
    const normalized = normalizeMcodeConfigOptions([modelSelect('m:minimax:MiniMax-M3:v:')])
    const model = selectWith(normalized, 'model')
    expect(model.currentValue).toBe('m:minimax:MiniMax-M3:v:thinking')
    expect(model.options).toEqual([
      {
        value: 'm:minimax:MiniMax-M3:v:thinking',
        name: 'MiniMax M3',
        description: 'Frontier model for complex agentic coding and deep reasoning'
      },
      {
        value: 'm:minimax:MiniMax-M3.1-Flash:v:thinking',
        name: 'MiniMax M3.1 Flash',
        description: 'Fast and versatile frontier model with deep reasoning'
      },
      {
        value: 'm:minimax:MiniMax-M3.1-Flash-Preview:v:thinking',
        name: 'MiniMax M3.1-Flash-Preview',
        description: 'Fast and versatile frontier model with deep reasoning'
      },
      {
        value: 'm:custom_provider:minimax-legacy:MiniMax-M2.7:v:thinking',
        name: 'MiniMax M2.7',
        description: 'Capable model for everyday programming tasks'
      }
    ])
    expect(normalized[1]).toEqual({
      type: 'select',
      id: 'thinkingEffort',
      name: 'Thinking effort',
      description: 'Controls whether thinking is enabled for this model.',
      category: 'thought_level',
      currentValue: 'off',
      options: [
        { value: 'off', name: 'Off' },
        { value: 'on', name: 'On' }
      ]
    })
  })

  it('drops a lone off variant instead of keeping a non-thinking model row', () => {
    const normalized = normalizeMcodeConfigOptions([
      {
        type: 'select',
        id: 'model',
        name: 'Model',
        category: 'model',
        currentValue: 'm:minimax:MiniMax-M3:v:',
        options: [
          { value: 'm:minimax:MiniMax-M3:v:', name: 'M3' },
          { value: 'm:minimax:MiniMax-M3.1-Flash:v:thinking', name: 'M3.1-Flash · thinking' }
        ]
      }
    ])
    const model = selectWith(normalized, 'model')
    expect(model.options).toEqual([
      {
        value: 'm:minimax:MiniMax-M3.1-Flash:v:thinking',
        name: 'MiniMax M3.1 Flash',
        description: 'Fast and versatile frontier model with deep reasoning'
      }
    ])
    expect(model.currentValue).toBe('m:minimax:MiniMax-M3.1-Flash:v:thinking')
  })

  it('injects the on default when the running model already has thinking on', () => {
    const normalized = normalizeMcodeConfigOptions([modelSelect('m:minimax:MiniMax-M3:v:thinking')])
    const injected = selectWith(normalized, 'thinkingEffort')
    expect(injected.currentValue).toBe('on')
  })

  it('remaps the thought_level the agent reports instead of injecting one', () => {
    const normalized = normalizeMcodeConfigOptions([
      modelSelect('m:minimax:MiniMax-M3.1-Flash:v:thinking'),
      {
        type: 'select',
        id: 'thinkingEffort',
        name: 'Thinking effort',
        category: 'thought_level',
        currentValue: 'default',
        options: [
          { value: 'default', name: 'Default' },
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' }
        ]
      }
    ])
    expect(normalized).toHaveLength(2)
    const effort = selectWith(normalized, 'thinkingEffort')
    expect(effort.currentValue).toBe('high')
    expect(effort.options).toEqual([
      { value: 'low', name: 'Low' },
      { value: 'high', name: 'High' }
    ])
  })
})
