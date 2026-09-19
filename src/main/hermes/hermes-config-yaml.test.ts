import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { disablePlugin, enablePlugin, updateConfigContent } from './hermes-config-yaml'

describe('Hermes config source preservation', () => {
  const prefix = [
    '# My model settings',
    'model:',
    "    name: 'custom-model'",
    '    temperature: 0.50',
    '    instructions: |-',
    '        Keep this indentation.',
    '        And this second line.',
    '',
    ''
  ].join('\n')
  const suffix = '\n# Keep these exact settings\nother: { limit: 9007199254740993, active: yes }\n'

  it('changes plugin lists without rewriting other settings or their comments', () => {
    const original = `${prefix}plugins: # My integrations
    enabled: [ 'other-plugin' ] # Keep this plugin
    disabled: [orca-status, "paused-plugin"] # Keep this setting
${suffix}`

    const result = updateConfigContent(original, enablePlugin)

    expect(result.detail).toBeUndefined()
    expect(result.content?.startsWith(prefix)).toBe(true)
    expect(result.content?.endsWith(suffix)).toBe(true)
    expect(result.content).toContain('plugins: # My integrations')
    expect(result.content).toContain("'other-plugin'")
    expect(result.content).toContain('# Keep this plugin')
    expect(result.content).toContain('# Keep this setting')
    expect(parse(result.content ?? '')).toMatchObject({
      plugins: { enabled: ['other-plugin', 'orca-status'], disabled: ['paused-plugin'] }
    })
  })

  it.each([
    '[other, # Keep this user plugin\n    orca-status]',
    '[other, # Keep this user plugin\n    orca-status, last]',
    '[ # Keep this user plugin\n    orca-status, other]',
    '[other, # Keep this user plugin\n    orca-status,]',
    '[ # Keep this user plugin\n    orca-status]'
  ])('preserves flow-list comments when removing Orca: %s', (list) => {
    for (const [field, updater] of [
      ['enabled', disablePlugin],
      ['disabled', enablePlugin]
    ] as const) {
      const original = `plugins:\n  ${field}: ${list}\n`
      const result = updateConfigContent(original, updater)
      expect(result.detail).toBeUndefined()
      expect(result.content).toContain('# Keep this user plugin')
      const config = parse(result.content ?? '')
      expect(config.plugins[field]).toEqual(
        parse(original).plugins[field].filter((name: string) => name !== 'orca-status')
      )
    }
  })

  it('keeps comments, quoting and order of other block-list plugins', () => {
    const original = [
      'plugins:',
      '    enabled:',
      '        # A plugin with its own configuration',
      '        - "z-plugin" # Leave me alone',
      "        - 'a-plugin'",
      '    settings: { z-plugin: { mode: "fast" } }',
      ''
    ].join('\n')

    const enabled = updateConfigContent(original, enablePlugin)
    expect(enabled.content).toContain('        # A plugin with its own configuration')
    expect(enabled.content).toContain('        - "z-plugin" # Leave me alone')
    expect(enabled.content).toContain("        - 'a-plugin'")
    expect(enabled.content).toContain('    settings: { z-plugin: { mode: "fast" } }')
    expect(parse(enabled.content ?? '')).toMatchObject({
      plugins: { enabled: ['z-plugin', 'a-plugin', 'orca-status'] }
    })

    const disabled = updateConfigContent(enabled.content, disablePlugin)
    expect(parse(disabled.content ?? '')).toMatchObject({
      plugins: { enabled: ['z-plugin', 'a-plugin'] }
    })
    expect(disabled.content).toContain('        - "z-plugin" # Leave me alone')
    expect(disabled.content).toContain('        # A plugin with its own configuration')
  })

  it.each([
    'plugins: { enabled: ["other", orca-status] } # installed\n',
    'plugins:\n  enabled:\n    - other\n    - orca-status # Installed\n',
    'plugins: &plugins {enabled: [orca-status]}\ncopy: *plugins\n'
  ])('does not rewrite an already enabled config: %s', (original) => {
    expect(updateConfigContent(original, enablePlugin)).toEqual({ content: original })
  })

  it.each([
    '# A config without plugins\nmodel: "demo"',
    'plugins: {enabled: ["other"]} # Keep this\n',
    'plugins:\n  settings: {other: true}\n'
  ])('does not rewrite a config without Orca during removal: %s', (original) => {
    expect(updateConfigContent(original, disablePlugin)).toEqual({ content: original })
  })

  it.each([
    '# Header\nmodel: "demo"\n',
    '# Header only\n',
    'plugins: # Keep the comment\n',
    'plugins: {} # Keep the comment\n',
    'plugins: {settings: {other: true}} # Keep the comment\n',
    'plugins:\n    settings: {other: true}\n',
    '{model: "demo"}',
    '---\nmodel: "demo"\n...\n'
  ])('adds missing plugin settings without dropping existing text: %s', (original) => {
    const result = updateConfigContent(original, enablePlugin)
    expect(result.detail).toBeUndefined()
    expect(parse(result.content ?? '')).toMatchObject({ plugins: { enabled: ['orca-status'] } })
    if (original.includes('#')) {
      expect(result.content).toContain(original.match(/#[^\n]*/)?.[0])
    }
    expect(updateConfigContent(result.content, enablePlugin)).toEqual({ content: result.content })
  })

  it('preserves CRLF and the lack of a final newline', () => {
    const original = '# Windows config\r\nplugins: {enabled: [other]}\r\nmodel: "demo"'
    const result = updateConfigContent(original, enablePlugin)
    expect(result.detail).toBeUndefined()
    expect(result.content?.replaceAll('\r\n', '')).not.toContain('\n')
    expect(result.content?.endsWith('model: "demo"')).toBe(true)
    expect(parse(result.content ?? '')).toMatchObject({
      plugins: { enabled: ['other', 'orca-status'] }
    })
  })

  it('preserves unrelated YAML anchors and aliases', () => {
    const original = 'model: &model {name: "demo"}\ncopy: *model\nplugins: {enabled: []}\n'
    const result = updateConfigContent(original, enablePlugin)
    expect(result.content?.startsWith('model: &model {name: "demo"}\ncopy: *model\n')).toBe(true)
    expect(result.detail).toBeUndefined()
  })

  it.each([
    'plugins: [unterminated',
    'plugins: {}\nplugins: {}\n',
    '---\nplugins: {}\n---\nmodel: demo\n',
    '- not-a-mapping\n'
  ])('rejects malformed documents without returning replacement content: %s', (original) => {
    expect(updateConfigContent(original, enablePlugin)).toMatchObject({
      content: null,
      detail: expect.any(String)
    })
  })

  it.each([
    'plugins: &plugins {enabled: [other]}\ncopy: *plugins\n',
    'shared: &plugins {enabled: [other]}\nplugins: *plugins\n',
    'plugins:\n  enabled: &enabled [other]\ncopy: *enabled\n'
  ])('refuses an edit that would also change an aliased configuration: %s', (original) => {
    expect(updateConfigContent(original, enablePlugin)).toMatchObject({
      content: null,
      detail: expect.any(String)
    })
  })
})
