import { describe, expect, it } from 'vitest'
import { mcodeModelEfforts, parseMcodeModelCatalog } from './mcode-model-catalog'

/** Shaped like mcode's config.yaml: the thinking settings it reads decide each model's row and efforts. */
const CONFIG_YAML = [
  'defaultModel: custom_provider:my-gateway/MiniMax-M2.7',
  'defaultModelVariant: thinking',
  'provider:',
  '  minimax:',
  '    name: MiniMax',
  '    model_order: [MiniMax-M3.1-Flash, MiniMax-M3]',
  '    models:',
  '      MiniMax-M3:',
  '        name: M3',
  '        variants: { none-thinking: { thinking: { type: disabled } }, thinking: { thinking: { type: adaptive } } }',
  '        thinking_config: { mode: switchable, default_value: "true" }',
  '      MiniMax-M3.1-Flash:',
  '        name: M3.1-Flash',
  '        variants: { none-thinking: { thinking: { type: disabled } }, thinking: { thinking: { type: adaptive } } }',
  '        thinking_config: { mode: forced_on }',
  '        thinking:',
  '          effortOptions: [default, low, high]',
  '          defaultEffort: default',
  '      MiniMax-Plain:',
  '        name: Plain',
  '      MiniMax-Retired:',
  '        name: Retired',
  '        enabled: false',
  'custom_provider:',
  '  my-gateway:',
  '    options: { baseURL: "https://llm.example.com/anthropic" }',
  '    models:',
  '      MiniMax-M2.7:',
  '        name: M2.7',
  '        thinking_config: { mode: forced_on }',
  '      MiniMax-M3:',
  '        name: M3'
].join('\n')

describe('parseMcodeModelCatalog', () => {
  it('lists each model as the selection id mcode accepts, with the efforts its thinking settings declare', () => {
    expect(parseMcodeModelCatalog(CONFIG_YAML)).toEqual([
      {
        id: 'm:minimax:MiniMax-M3.1-Flash:v:thinking',
        label: 'MiniMax M3.1 Flash',
        isDefault: false,
        efforts: [
          { value: 'default', label: 'Default' },
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' }
        ],
        defaultEffort: 'default',
        declaredDefaultEffort: 'default'
      },
      {
        id: 'm:minimax:MiniMax-M3:v:thinking',
        label: 'MiniMax M3 (minimax)',
        isDefault: false,
        efforts: [
          { value: 'off', label: 'Off' },
          { value: 'on', label: 'On' }
        ],
        defaultEffort: 'on',
        declaredDefaultEffort: 'on'
      },
      {
        id: 'm:minimax:MiniMax-Plain:u',
        label: 'MiniMax Plain',
        isDefault: false,
        efforts: [],
        declaredDefaultEffort: null
      },
      {
        id: 'm:custom_provider%3Amy-gateway:MiniMax-M2.7:v:thinking',
        label: 'MiniMax M2.7',
        isDefault: true,
        efforts: [],
        declaredDefaultEffort: null
      },
      {
        id: 'm:custom_provider%3Amy-gateway:MiniMax-M3:u',
        label: 'MiniMax M3 (my-gateway)',
        isDefault: false,
        efforts: [],
        declaredDefaultEffort: null
      }
    ])
  })

  it('lists no model of a migrated legacy copy of the official provider, nor of a withdrawn or disabled one', () => {
    // A default naming the legacy copy resolves to the official provider's model, not another provider's.
    const catalog = parseMcodeModelCatalog(
      [
        'defaultModel: custom_provider:minimax-legacy/MiniMax-M3',
        'provider:',
        '  other-gateway:',
        '    models:',
        '      MiniMax-M3: { name: M3 }',
        '  minimax:',
        '    models:',
        '      MiniMax-M3: { name: M3 }',
        'custom_provider:',
        '  minimax-legacy:',
        '    models:',
        '      MiniMax-M3: { name: M3 }',
        '      MiniMax-M2.7: { name: M2.7 }',
        '  minimax-legacy-2:',
        '    options: { baseURL: "https://agent.minimax.cn/anthropic" }',
        '    models:',
        '      MiniMax-M3.1-Flash-Preview: { name: M3.1-Flash-Preview }',
        '  my-gateway:',
        '    options: { baseURL: "https://llm.example.com/anthropic" }',
        '    models:',
        '      MiniMax-M2.7: { name: M2.7 }',
        '  withdrawn-gateway:',
        '    withdrawn: true',
        '    models:',
        '      MiniMax-M2.7: { name: M2.7 }',
        '  disabled-gateway:',
        '    enabled: false',
        '    models:',
        '      MiniMax-M2.7: { name: M2.7 }'
      ].join('\n')
    )
    expect(catalog.map(({ id, isDefault }) => ({ id, isDefault }))).toEqual([
      { id: 'm:other-gateway:MiniMax-M3:u', isDefault: false },
      { id: 'm:minimax:MiniMax-M3:u', isDefault: true },
      { id: 'm:custom_provider%3Amy-gateway:MiniMax-M2.7:u', isDefault: false }
    ])
  })

  it("gives a custom provider's copy of a shipped model none of its efforts", () => {
    expect(mcodeModelEfforts({ modelId: 'm:minimax:MiniMax-M3:v:thinking' }).efforts).toEqual([
      { value: 'off', label: 'Off' },
      { value: 'on', label: 'On' }
    ])
    expect(
      mcodeModelEfforts({ modelId: 'm:custom_provider%3Amy-gateway:MiniMax-M3:v:thinking' })
    ).toEqual({
      efforts: [],
      declaredDefaultEffort: null
    })
  })

  it('throws instead of substituting built-in models when the config names none or cannot be read', () => {
    expect(() => parseMcodeModelCatalog('logLevel: info')).toThrow('mcode did not list its models')
    expect(() => parseMcodeModelCatalog('provider: [broken]')).toThrow(
      'mcode config.yaml is not a readable model catalog'
    )
    expect(() => parseMcodeModelCatalog('')).toThrow(
      'mcode config.yaml is not a readable model catalog'
    )
  })
})
