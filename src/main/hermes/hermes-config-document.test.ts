import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  disablePlugin,
  enablePlugin,
  installOrcaStatusConfig,
  removeOrcaStatusConfig,
  updateConfigContent
} from './hermes-config-yaml'
import { HERMES_CLIENT_ENV_PASSTHROUGH } from './hermes-managed-plugin-source'

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

  // Hermes reads a key with no value as unset, e.g. a section whose only child is commented out.
  it.each([
    'plugins:\n  # clone_timeout_seconds: 300\nmodel: "001"\n',
    'plugins: # none yet',
    'plugins:\n  enabled:\n    # - other\n  disabled:\n',
    'plugins:\r\n  custom: "off"\r\n  enabled:\r\nterminal:\r\n',
    'terminal:\n  backend: local\n  client_env_passthrough: # e.g. GEM_HOME\n',
    'plugins: ~ # none\nterminal:\n  client_env_passthrough: null\n',
    '{plugins: {custom: "off", enabled: }, terminal: }\n',
    '{plugins: # none\n}\n',
    '{\n  plugins: {custom: "off", enabled: # ours\n  },\n  terminal: # env\n}\n',
    'plugins:\r\n  ~\r\nterminal:\r\n  client_env_passthrough: NULL\r\n'
  ])('fills a key that has no value as if it were absent (%j)', (input) => {
    const installed = updateConfigContent(input, installOrcaStatusConfig)
    expect(installed.detail).toBeUndefined()
    const output = installed.content ?? ''
    const parsed = parse(input)
    const withLists = (enabled: string[], passthrough: readonly string[]) => ({
      ...parsed,
      plugins: { ...parsed.plugins, enabled },
      terminal: { ...parsed.terminal, client_env_passthrough: passthrough }
    })
    expect(parse(output)).toEqual(withLists(['orca-status'], HERMES_CLIENT_ENV_PASSTHROUGH))
    for (const comment of input.match(/#[^\r\n]*/g) ?? []) {
      expect(output).toContain(comment)
    }
    expect(output).not.toMatch(/[ \t]\r?$/m)
    if (input.includes('\r\n')) {
      expect(output.replaceAll('\r\n', '')).not.toContain('\n')
    }
    const removed = updateConfigContent(output, removeOrcaStatusConfig).content ?? ''
    expect(parse(removed)).toEqual(withLists([], []))
  })

  it('adds the passthrough beside an anchored terminal setting', () => {
    const input =
      'terminal:\n  docker_env: &env {A: "1"}\n  backend: local\nshared_env: *env\nplugins:\n  enabled: [other]\n'
    const output = updateConfigContent(input, installOrcaStatusConfig).content ?? ''
    expect(parse(output)).toMatchObject({
      terminal: { docker_env: { A: '1' }, backend: 'local' },
      shared_env: { A: '1' }
    })
    expect(parse(output).terminal.client_env_passthrough).toContain('ORCA_AGENT_PANE')
    expect(output).toContain('docker_env: &env {A: "1"}')
    expect(output).toContain('shared_env: *env')
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

  it.each([
    [
      'plugins:\r\n  enabled:\r\n    - other\r\n    # - spare\r\n\r\n\r\nmodel: x\r\n',
      'plugins:\r\n  enabled:\r\n    - other\r\n    - orca-status\r\n    # - spare\r\n\r\n\r\nmodel: x\r\n'
    ],
    [
      '---\r\n# a\r\n\r\n# b\r\n',
      '---\r\nplugins:\r\n  enabled:\r\n    - orca-status\r\n# a\r\n\r\n# b\r\n'
    ]
  ])(
    'keeps a CRLF edit free of stray carriage returns when comments follow (%j)',
    (initial, expected) => {
      expect(updateConfigContent(initial, enablePlugin).content).toBe(expected)
    }
  )
})
