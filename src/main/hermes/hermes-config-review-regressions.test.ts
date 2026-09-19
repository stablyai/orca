import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { disablePlugin, enablePlugin, updateConfigContent } from './hermes-config-yaml'

describe('Hermes block-list footer preservation', () => {
  it.each([
    {
      name: 'installation before an indented sibling',
      source: 'plugins:\n  enabled:\n    - a\n    # footer comment\n  disabled: [x]\n',
      updater: enablePlugin,
      expected: { plugins: { enabled: ['a', 'orca-status'], disabled: ['x'] } },
      sibling: '  disabled: [x]\n'
    },
    {
      name: 'removal with another enabled plugin and a sibling',
      source:
        'plugins:\n  enabled:\n    - orca-status\n    - a\n    # footer comment\n  settings: {a: true}\n',
      updater: disablePlugin,
      expected: { plugins: { enabled: ['a'], settings: { a: true } } },
      sibling: '  settings: {a: true}\n'
    },
    {
      name: 'removal of the sole enabled plugin with a trailing comment',
      source: 'plugins:\n  enabled:\n    - orca-status\n    # footer comment\n',
      updater: disablePlugin,
      expected: { plugins: { enabled: [] } },
      sibling: ''
    },
    {
      name: 'installation with CRLF and no final newline',
      source: 'plugins:\r\n  enabled:\r\n    - a\r\n    # footer comment\r\n  disabled: [x]',
      updater: enablePlugin,
      expected: { plugins: { enabled: ['a', 'orca-status'], disabled: ['x'] } },
      sibling: '  disabled: [x]'
    },
    {
      name: 'sole-plugin removal with CRLF and an unterminated footer',
      source: 'plugins:\r\n  enabled:\r\n    - orca-status\r\n    # footer comment',
      updater: disablePlugin,
      expected: { plugins: { enabled: [] } },
      sibling: ''
    },
    {
      name: 'installation removes the sole disabled plugin without swallowing its sibling',
      source:
        'plugins:\n  enabled: [orca-status]\n  disabled:\n    - orca-status\n    # footer comment\n  settings: {a: true}\n',
      updater: enablePlugin,
      expected: {
        plugins: { enabled: ['orca-status'], disabled: [], settings: { a: true } }
      },
      sibling: '  settings: {a: true}\n'
    }
  ])('$name', ({ source, updater, expected, sibling }) => {
    const result = updateConfigContent(source, updater)

    expect(result.detail).toBeUndefined()
    expect(result.content).not.toBeNull()
    const content = result.content ?? ''
    expect(parse(content)).toEqual(expected)
    expect(content.match(/# footer comment/g)).toHaveLength(1)
    if (sibling) {
      expect(content).toContain(sibling)
    }
    expect(content.endsWith('\n')).toBe(source.endsWith('\n'))
    if (source.includes('\r\n')) {
      expect(content.replaceAll('\r\n', '')).not.toContain('\n')
    }
  })
})

describe('Hermes edits resolve aliases to nodes rather than anchor names', () => {
  it.each([
    {
      name: 'an early plugins map shadowed before the alias',
      source: 'plugins: &shared {enabled: [a]}\nother: &shared {enabled: [b]}\ncopy: *shared\n',
      expected: {
        plugins: { enabled: ['a', 'orca-status'] },
        other: { enabled: ['b'] },
        copy: { enabled: ['b'] }
      },
      unchanged: 'other: &shared {enabled: [b]}\ncopy: *shared\n'
    },
    {
      name: 'an early enabled list shadowed before the alias',
      source: 'plugins:\n  enabled: &shared [a]\nother: &shared [b]\ncopy: *shared\n',
      expected: {
        plugins: { enabled: ['a', 'orca-status'] },
        other: ['b'],
        copy: ['b']
      },
      unchanged: 'other: &shared [b]\ncopy: *shared\n'
    },
    {
      name: 'a map alias resolved before plugins reuses the name',
      source: 'other: &shared {enabled: [b]}\ncopy: *shared\nplugins: &shared {enabled: [a]}\n',
      expected: {
        other: { enabled: ['b'] },
        copy: { enabled: ['b'] },
        plugins: { enabled: ['a', 'orca-status'] }
      },
      unchanged: 'other: &shared {enabled: [b]}\ncopy: *shared\n'
    },
    {
      name: 'a list alias resolved before enabled reuses the name',
      source: 'other: &shared [b]\ncopy: *shared\nplugins:\n  enabled: &shared [a]\n',
      expected: {
        other: ['b'],
        copy: ['b'],
        plugins: { enabled: ['a', 'orca-status'] }
      },
      unchanged: 'other: &shared [b]\ncopy: *shared\n'
    }
  ])('allows editing $name', ({ source, expected, unchanged }) => {
    const result = updateConfigContent(source, enablePlugin)

    expect(result.detail).toBeUndefined()
    expect(parse(result.content ?? '')).toEqual(expected)
    expect(result.content).toContain(unchanged)
  })

  it('allows disabling an early enabled list when the alias resolves to a later list', () => {
    const source =
      'plugins:\n  enabled: &shared [a, orca-status]\nother: &shared [b]\ncopy: *shared\n'
    const result = updateConfigContent(source, disablePlugin)

    expect(result.detail).toBeUndefined()
    expect(parse(result.content ?? '')).toEqual({
      plugins: { enabled: ['a'] },
      other: ['b'],
      copy: ['b']
    })
    expect(result.content).toContain('other: &shared [b]\ncopy: *shared\n')
  })

  it.each([
    {
      name: 'an early plugins map referenced before a later redefinition',
      source:
        'plugins: &shared {enabled: [a]}\nfirstCopy: *shared\nother: &shared {enabled: [b]}\nlastCopy: *shared\n'
    },
    {
      name: 'an early enabled list referenced before a later redefinition',
      source:
        'plugins:\n  enabled: &shared [a]\nfirstCopy: *shared\nother: &shared [b]\nlastCopy: *shared\n'
    },
    {
      name: 'the latest plugins map referenced after reusing a name',
      source: 'other: &shared {enabled: [b]}\nplugins: &shared {enabled: [a]}\ncopy: *shared\n'
    },
    {
      name: 'the latest enabled list referenced after reusing a name',
      source: 'other: &shared [b]\nplugins:\n  enabled: &shared [a]\ncopy: *shared\n'
    }
  ])('refuses editing $name', ({ source }) => {
    expect(updateConfigContent(source, enablePlugin)).toMatchObject({
      content: null,
      detail: expect.stringContaining('aliased')
    })
  })
})
