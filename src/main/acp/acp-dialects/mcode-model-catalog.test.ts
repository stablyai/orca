import { describe, expect, it } from 'vitest'
import { mcodeModelEfforts, parseMcodeModelCatalog } from './mcode-model-catalog'

const CONFIG_YAML = [
  'provider:',
  '  minimax:',
  '    name: MiniMax',
  '    models:',
  '      MiniMax-M3:',
  '        name: M3',
  '        thinking_config: { mode: switchable, default_value: "true" }',
  '      MiniMax-M3.1-Flash:',
  '        name: M3.1-Flash',
  '        thinking: { effortOptions: [default, low, medium, high, xhigh, max] }',
  '      MiniMax-M3.1-Flash-Preview:',
  '        name: M3.1-Flash-Preview',
  '    model_order: [MiniMax-M3.1-Flash, MiniMax-M3]',
  'defaultModel: minimax/MiniMax-M3.1-Flash',
  'custom_provider:',
  '  minimax-legacy:',
  '    models:',
  '      MiniMax-M2.7:',
  '        name: M2.7',
  '      MiniMax-M3:',
  '        name: M3'
].join('\n')

describe('parseMcodeModelCatalog', () => {
  it('lists the configured models in model_order with efforts from their ids', () => {
    expect(parseMcodeModelCatalog(CONFIG_YAML)).toEqual([
      {
        id: 'm:minimax:MiniMax-M3.1-Flash:v:thinking',
        label: 'MiniMax M3.1 Flash',
        description: 'Fast and versatile frontier model with deep reasoning',
        isDefault: true,
        efforts: [
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
          { value: 'xhigh', label: 'Extra high' },
          { value: 'max', label: 'Max' }
        ],
        defaultEffort: 'high',
        declaredDefaultEffort: 'high'
      },
      {
        id: 'm:minimax:MiniMax-M3:v:thinking',
        label: 'MiniMax M3',
        description: 'Frontier model for complex agentic coding and deep reasoning',
        isDefault: false,
        efforts: [
          { value: 'off', label: 'Off' },
          { value: 'on', label: 'On' }
        ],
        defaultEffort: 'on',
        declaredDefaultEffort: 'on'
      },
      {
        id: 'm:minimax:MiniMax-M3.1-Flash-Preview:v:thinking',
        label: 'MiniMax M3.1-Flash-Preview',
        description: 'Fast and versatile frontier model with deep reasoning',
        isDefault: false,
        efforts: [
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
          { value: 'xhigh', label: 'Extra high' },
          { value: 'max', label: 'Max' }
        ],
        defaultEffort: 'high',
        declaredDefaultEffort: 'high'
      },
      {
        id: 'm:custom_provider:minimax-legacy:MiniMax-M2.7:v:thinking',
        label: 'MiniMax M2.7',
        description: 'Capable model for everyday programming tasks',
        isDefault: false,
        efforts: [
          { value: 'off', label: 'Off' },
          { value: 'on', label: 'On' }
        ],
        defaultEffort: 'on',
        declaredDefaultEffort: 'on'
      },
      {
        id: 'm:custom_provider:minimax-legacy:MiniMax-M3:v:thinking',
        label: 'MiniMax M3 (minimax-legacy)',
        description: 'Frontier model for complex agentic coding and deep reasoning',
        isDefault: false,
        efforts: [
          { value: 'off', label: 'Off' },
          { value: 'on', label: 'On' }
        ],
        defaultEffort: 'on',
        declaredDefaultEffort: 'on'
      }
    ])
  })

  it('marks only the first match as default for a bare defaultModel', () => {
    const config = [
      'provider:',
      '  minimax:',
      '    models:',
      '      MiniMax-M3:',
      '        name: M3',
      'custom_provider:',
      '  minimax-legacy:',
      '    models:',
      '      MiniMax-M3:',
      '        name: M3',
      'defaultModel: MiniMax-M3'
    ].join('\n')
    expect(parseMcodeModelCatalog(config).map((model) => [model.id, model.isDefault])).toEqual([
      ['m:minimax:MiniMax-M3:v:thinking', true],
      ['m:custom_provider:minimax-legacy:MiniMax-M3:v:thinking', false]
    ])
  })

  it('throws instead of returning a fallback when no model is listed', () => {
    expect(() => parseMcodeModelCatalog('logLevel: info')).toThrow('mcode did not list its models')
  })

  it('throws on a config that is not a model catalog', () => {
    expect(() => parseMcodeModelCatalog('provider: [broken]')).toThrow(
      'mcode config.yaml is not a readable model catalog'
    )
    expect(() => parseMcodeModelCatalog('')).toThrow(
      'mcode config.yaml is not a readable model catalog'
    )
  })
})

describe('mcodeModelEfforts', () => {
  it('maps model ids to the same menus the session dialect offers', () => {
    expect(mcodeModelEfforts({ modelId: 'm:minimax:MiniMax-M3.1-Flash:v:thinking' })).toEqual({
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'xhigh', label: 'Extra high' },
        { value: 'max', label: 'Max' }
      ],
      defaultEffort: 'high',
      declaredDefaultEffort: 'high'
    })
    expect(mcodeModelEfforts({ modelId: 'm:minimax:MiniMax-M3:v:thinking' })).toEqual({
      efforts: [
        { value: 'off', label: 'Off' },
        { value: 'on', label: 'On' }
      ],
      defaultEffort: 'on',
      declaredDefaultEffort: 'on'
    })
    expect(mcodeModelEfforts({ modelId: 'm:minimax:MiniMax-M2.7:v:thinking' }).efforts).toEqual([
      { value: 'off', label: 'Off' },
      { value: 'on', label: 'On' }
    ])
    expect(mcodeModelEfforts({ modelId: 'm:minimax:MiniMax-M4:v:thinking' })).toEqual({
      efforts: [],
      declaredDefaultEffort: null
    })
  })
})
