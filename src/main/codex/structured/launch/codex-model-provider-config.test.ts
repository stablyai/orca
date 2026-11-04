import { describe, expect, it } from 'vitest'
import { readCodexTopLevelModelProvider } from './codex-model-provider-config'

describe('readCodexTopLevelModelProvider', () => {
  it.each([
    ['missing provider', 'model = "gpt-5"\n', null],
    ['OpenAI provider', 'model_provider = "openai" # default\n', 'openai'],
    ['literal custom provider', "model_provider = 'codex-lb'\n", 'codex-lb'],
    ['quoted key', '"model_provider" = "codex-lb"\n', 'codex-lb'],
    ['escaped quoted key', '"model\\u005Fprovider" = "codex-lb"\n', 'codex-lb'],
    ['escaped provider', 'model_provider = "codex\\u002Dlb"\n', 'codex-lb'],
    ['single-line multiline OpenAI', 'model_provider = """openai"""\n', 'openai'],
    ['single-line multiline custom', "model_provider = '''codex-lb'''\n", 'codex-lb'],
    ['CRLF custom provider', 'model = "gpt-5"\r\nmodel_provider = "codex-lb"\r\n', 'codex-lb'],
    [
      'continued multiline custom',
      ['model_provider = """\\', '  codex-lb"""', ''].join('\n'),
      'codex-lb'
    ],
    ['profile provider', ['[profiles.custom]', 'model_provider = "codex-lb"', ''].join('\n'), null],
    [
      'provider-like multiline data',
      [
        'developer_instructions = """',
        '[profiles.custom]',
        'model_provider = "not-a-setting"',
        '"""',
        'model_provider = "openai"',
        ''
      ].join('\n'),
      'openai'
    ],
    [
      'provider-like array data',
      [
        'notify = [',
        '  "model_provider = \\"not-a-setting\\"",',
        ']',
        'model_provider = "openai"',
        ''
      ].join('\n'),
      'openai'
    ]
  ])('reads %s', (_description, config, expected) => {
    expect(readCodexTopLevelModelProvider(config)).toBe(expected)
  })

  it('uses the first duplicate assignment deterministically', () => {
    expect(
      readCodexTopLevelModelProvider(
        ['model_provider = "openai"', 'model_provider = "codex-lb"', ''].join('\n')
      )
    ).toBe('openai')
  })

  it.each([
    ['unquoted value', 'model_provider = codex-lb\n'],
    ['unterminated value', 'model_provider = "codex-lb\n'],
    ['assignment after a table', '[profiles.default]\nmodel_provider = "codex-lb"\n']
  ])('ignores malformed or non-root %s', (_description, config) => {
    expect(readCodexTopLevelModelProvider(config)).toBeNull()
  })
})
