import { describe, expect, it } from 'vitest'
import { extractInlineCodexHooks, stripInlineCodexHookSections } from './config-toml-hooks'

describe('Codex inline hook config', () => {
  it('extracts event arrays while ignoring hooks.state tables', () => {
    const config = [
      'model = "gpt-5"',
      '',
      '[[hooks.Stop]]',
      'matcher = "*"',
      '[[hooks.Stop.hooks]]',
      'type = "command"',
      'command = "user-hook"',
      'timeout = 12',
      '',
      '[hooks.state."source:stop:0:0"]',
      'enabled = true',
      'trusted_hash = "hash"',
      ''
    ].join('\n')

    expect(extractInlineCodexHooks(config)).toEqual({
      Stop: [
        {
          matcher: '*',
          hooks: [{ type: 'command', command: 'user-hook', timeout: 12 }]
        }
      ]
    })
  })

  it('removes event array tables byte-preservingly but keeps state and lookalike strings', () => {
    const config = [
      'model = "gpt-5"',
      'notes = """',
      '[[hooks.Fake]]',
      '"""',
      '',
      '[[hooks.Stop]]',
      'matcher = "*"',
      '[[hooks.Stop.hooks]]',
      'type = "command"',
      'command = "user-hook"',
      '',
      '[hooks.state."source:stop:0:0"]',
      'enabled = true',
      ''
    ].join('\n')

    expect(stripInlineCodexHookSections(config)).toBe(
      [
        'model = "gpt-5"',
        'notes = """',
        '[[hooks.Fake]]',
        '"""',
        '',
        '[hooks.state."source:stop:0:0"]',
        'enabled = true',
        ''
      ].join('\n')
    )
  })

  it('removes quoted event array tables while preserving quoted state tables', () => {
    const config = [
      'model = "gpt-5"',
      '',
      '[["hooks".Stop]]',
      'matcher = "*"',
      '[["hooks".Stop.hooks]]',
      'type = "command"',
      'command = "quoted-user-hook"',
      '',
      '["hooks".state."source:stop:0:0"]',
      'enabled = true',
      ''
    ].join('\n')

    expect(extractInlineCodexHooks(config)).toEqual({
      Stop: [
        {
          matcher: '*',
          hooks: [{ type: 'command', command: 'quoted-user-hook' }]
        }
      ]
    })
    expect(stripInlineCodexHookSections(config)).toBe(
      [
        'model = "gpt-5"',
        '',
        '["hooks".state."source:stop:0:0"]',
        'enabled = true',
        ''
      ].join('\n')
    )
  })

  it('rejects semantic hook declarations that cannot be removed byte-preservingly', () => {
    const config = [
      '[hooks]',
      'Stop = [{ hooks = [{ type = "command", command = "inline-user-hook" }] }]',
      ''
    ].join('\n')

    expect(extractInlineCodexHooks(config).Stop).toHaveLength(1)
    expect(() => stripInlineCodexHookSections(config)).toThrow(
      'unsupported inline Codex hook representation'
    )
  })
})
