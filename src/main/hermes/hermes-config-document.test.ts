import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { disablePlugin, enablePlugin, updateConfigContent } from './hermes-config-yaml'

const fixture = [
  '# Operator documentation',
  'model: "001" # keep quoted',
  'prompt: |',
  '  First line',
  '  Second line',
  'defaults: &defaults',
  '  temperature: 0.25 # setting',
  'other: *defaults',
  '',
  'plugins:',
  '  enabled:',
  '    - "zeta" # last alphabetically',
  '    - alpha # first occurrence',
  '    - alpha # duplicate belongs to user',
  '  disabled: [orca-status, blocked] # disabled choices',
  '  custom: "off" # unrelated plugin setting',
  '# End documentation',
  ''
].join('\n')

describe('Hermes YAML document edits', () => {
  it.each(['\n', '\r\n'])('preserves comments and values through install/remove (%j)', (eol) => {
    const initial = fixture.replaceAll('\n', eol)
    const installed = updateConfigContent(initial, enablePlugin)
    expect(installed.detail).toBeUndefined()
    expect(installed.content).not.toBeNull()
    const enabled = installed.content ?? ''
    expect(parse(enabled)).toEqual({
      ...parse(initial),
      plugins: {
        enabled: ['zeta', 'alpha', 'alpha', 'orca-status'],
        disabled: ['blocked'],
        custom: 'off'
      }
    })
    const removed = updateConfigContent(enabled, disablePlugin).content ?? ''
    expect(parse(removed)).toEqual({
      ...parse(initial),
      plugins: { enabled: ['zeta', 'alpha', 'alpha'], disabled: ['blocked'], custom: 'off' }
    })
    for (const output of [enabled, removed]) {
      for (const comment of initial.match(/#[^\r\n]*/g) ?? []) {
        expect(output).toContain(comment)
      }
      expect(output).toContain('model: "001" # keep quoted')
      expect(output).toContain(`prompt: |${eol}  First line${eol}  Second line`)
      expect(output).toContain('&defaults')
      expect(output).toContain('*defaults')
      if (eol === '\r\n') {
        expect(output.replaceAll('\r\n', '')).not.toContain('\n')
      }
    }
  })

  it.each([
    '# existing\r\nplugins:\r\n  enabled: [zeta, orca-status, alpha, alpha]\r\n',
    'plugins: &plugins\n  enabled: [orca-status]\nother: *plugins\n'
  ])('returns exact bytes for a semantic no-op', (input) => {
    expect(updateConfigContent(input, enablePlugin)).toEqual({ content: input })
  })

  it.each(['# no plugins\nmodel: test\n', 'plugins:\n  disabled: [blocked]\n'])(
    'does not add absent lists when removing',
    (input) => expect(updateConfigContent(input, disablePlugin)).toEqual({ content: input })
  )

  it('retains comments attached to removed Orca entries', () => {
    const input =
      'plugins:\n  enabled:\n    # keep this note\n    - orca-status # managed entry\n    - other\n'
    const output = updateConfigContent(input, disablePlugin).content ?? ''
    expect(parse(output).plugins.enabled).toEqual(['other'])
    expect(output).toContain('# keep this note')
    expect(output).toContain('# managed entry')
    expect(output.match(/# keep this note/g)).toHaveLength(1)
  })

  it.each([
    'plugins: [',
    'plugins: {}\nplugins: {}\n',
    '- invalid root\n',
    'plugins: unexpected\n',
    'plugins:\n  enabled: not-a-list\n',
    'plugins:\n  enabled: [123]\n',
    'plugins:\n  disabled: not-a-list\n',
    'plugins: !custom {}\n',
    'defaults: &defaults {plugins: {enabled: [other]}}\n<<: *defaults\n',
    'defaults: &defaults {enabled: [other]}\nplugins:\n  <<: *defaults\n',
    'plugins: &plugins\n  enabled: [other]\nother: *plugins\n',
    'plugins:\n  enabled: &enabled [other]\nother: *enabled\n',
    'enabled: &enabled [other]\nplugins:\n  enabled: *enabled\n',
    'plugins:\n  enabled: [*missing]\n'
  ])('refuses an unsafe update without a replacement (%s)', (input) => {
    const output = updateConfigContent(input, enablePlugin)
    expect(output.content).toBeNull()
    expect(output.detail).toBeTruthy()
  })

  it('keeps folded scalars, quoted strings and long lines in a real update', () => {
    const input = `# header\nprompt: >-\n  First line\n  Second line\nquoted: 'off'\nlong: ${'word '
      .repeat(30)
      .trimEnd()}\nplugins: {enabled: [other]}\n`
    const output = updateConfigContent(input, enablePlugin).content ?? ''
    expect(output).toContain('prompt: >-\n  First line\n  Second line\n')
    expect(output).toContain("quoted: 'off'")
    expect(output).toContain(`long: ${'word '.repeat(30).trimEnd()}\n`)
    expect(parse(output)).toEqual({
      ...parse(input),
      plugins: { enabled: ['other', 'orca-status'] }
    })
  })

  it.each(['\n', '\r\n'])(
    'leaves unrelated source bytes intact with unusual indentation (%j)',
    (eol) => {
      const prefix =
        'model:    "001" # spacing\nprompt: >-\n    First\n    Second\n\n# plugins\nplugins:\n    custom: |-\n        Unrelated\n        text\n'.replaceAll(
          '\n',
          eol
        )
      const input = `${prefix}    enabled: [other] # choices${eol}# ending${eol}`
      const installed = updateConfigContent(input, enablePlugin).content ?? ''
      expect(installed.startsWith(prefix)).toBe(true)
      expect(installed.endsWith(`# ending${eol}`)).toBe(true)
      const removed = updateConfigContent(installed, disablePlugin).content ?? ''
      expect(removed.startsWith(prefix)).toBe(true)
      expect(parse(removed)).toEqual(parse(input))
    }
  )

  it.each([
    'model: "001"',
    'model: "001"\n# end\n...\n',
    '{model: "001"}\n',
    'plugins: {} # empty\n',
    'plugins: {custom: "off",} # flow\n',
    'plugins:\n    custom: >-\n        First\n        Second\n# end\n'
  ])('inserts missing plugin keys without losing other values (%s)', (input) => {
    const installed = updateConfigContent(input, enablePlugin)
    expect(installed.detail).toBeUndefined()
    const output = installed.content ?? ''
    const parsed = parse(input)
    expect(parse(output)).toEqual({
      ...parsed,
      plugins: { ...parsed.plugins, enabled: ['orca-status'] }
    })
    for (const comment of input.match(/#[^\r\n]*/g) ?? []) {
      expect(output).toContain(comment)
    }
    if (input.includes('First')) {
      expect(output).toContain('custom: >-\n        First\n        Second\n')
    }
  })

  it.each(['', '# empty document\n', 'null\n'])('enables a plugin in an empty config', (input) => {
    const output = updateConfigContent(input, enablePlugin).content ?? ''
    expect(parse(output)).toEqual({ plugins: { enabled: ['orca-status'] } })
    if (input.includes('#')) {
      expect(output).toContain('# empty document')
    }
  })
})
