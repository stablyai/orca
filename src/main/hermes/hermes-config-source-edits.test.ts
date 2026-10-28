import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import { disablePlugin, enablePlugin, updateConfigContent } from './hermes-config-yaml'

describe.each(['\n', '\r\n'])('Hermes source edit boundaries (%j)', (eol) => {
  describe.each([
    {
      operation: 'remove',
      key: 'enabled',
      updater: disablePlugin,
      expected: { enabled: [] }
    },
    {
      operation: 'install',
      key: 'disabled',
      updater: enablePlugin,
      expected: { disabled: [], enabled: ['orca-status'] }
    }
  ])('$operation with an emptied block list', ({ key, updater, expected }) => {
    it('replaces a minimal indentless list without a final newline', () => {
      const input = `plugins:${eol}  ${key}:${eol}  - orca-status`
      const result = updateConfigContent(input, updater)
      expect(result.detail).toBeUndefined()
      const document = parseDocument(result.content ?? '')
      expect(document.errors).toEqual([])
      expect(document.warnings).toEqual([])
      expect(document.toJS()).toEqual({ plugins: expected })
    })

    it.each([
      ['indentless', '  ', '  '],
      ['deeper indentless', '    ', '    '],
      ['indented', '  ', '    ']
    ])('preserves comments and unrelated settings (%s)', (_name, keyIndent, listIndent) => {
      const prefix = [
        'model:    "001" # untouched spacing',
        'plugins:',
        `${keyIndent}"${key}": # list note`,
        `${listIndent}# first choice`,
        ''
      ].join(eol)
      const custom = `${keyIndent}custom: 'off' # plugin setting${eol}`
      const suffix = ['prompt: |-', '  First', '  Second', ''].join(eol)
      const input = `${prefix}${listIndent}- orca-status # managed choice${eol}${custom}${suffix}`
      const result = updateConfigContent(input, updater)
      expect(result.detail).toBeUndefined()
      const output = result.content ?? ''
      const document = parseDocument(output)
      expect(document.errors).toEqual([])
      expect(document.warnings).toEqual([])
      expect(document.toJS()).toEqual({
        model: '001',
        plugins: { ...expected, custom: 'off' },
        prompt: 'First\nSecond'
      })
      expect(output.startsWith(prefix)).toBe(true)
      expect(output).toContain(custom)
      expect(output.endsWith(suffix)).toBe(true)
      expect(output.match(/# managed choice/g)).toHaveLength(1)
      if (eol === '\r\n') {
        expect(output.replaceAll(eol, '')).not.toContain('\n')
      }
    })
  })

  it.each([
    {
      name: 'plugin trailing comma before a comment',
      input: 'plugins: {custom: keep, # retain this comment\n  }\n',
      expected: { plugins: { custom: 'keep', enabled: ['orca-status'] } }
    },
    {
      name: 'root trailing comma before a comment',
      input: '{model: "001", # retain this comment\n}\n',
      expected: { model: '001', plugins: { enabled: ['orca-status'] } }
    },
    {
      name: 'plugin trailing comma before several comments',
      input: 'plugins: {custom: "keep # ,", # first\n  # last\n  } # outside\n',
      expected: { plugins: { custom: 'keep # ,', enabled: ['orca-status'] } }
    },
    {
      name: 'root trailing comma after a nested map',
      input: '{model: {name: "001",}, # first\n # last\n}\n',
      expected: { model: { name: '001' }, plugins: { enabled: ['orca-status'] } }
    },
    {
      name: 'plugin comment ending in a comma without a separator',
      input: 'plugins: {custom: keep # this comma is only a comment ,\n  }\n',
      expected: { plugins: { custom: 'keep', enabled: ['orca-status'] } }
    },
    {
      name: 'root comment ending in a comma without a separator',
      input: '{model: "001" # this comma is only a comment ,\n}\n',
      expected: { model: '001', plugins: { enabled: ['orca-status'] } }
    },
    {
      name: 'earlier plugin separator without a trailing comma',
      input: 'plugins: {custom: keep, extra: "off" # last value\n  }\n',
      expected: { plugins: { custom: 'keep', extra: 'off', enabled: ['orca-status'] } }
    },
    {
      name: 'nested sequence comma without a mapping separator',
      input: 'plugins: {custom: [one, two,] # nested comma only\n  }\n',
      expected: { plugins: { custom: ['one', 'two'], enabled: ['orca-status'] } }
    }
  ])('inserts entries with $name', ({ input, expected }) => {
    const source = input.replaceAll('\n', eol)
    const result = updateConfigContent(source, enablePlugin)
    expect(result.detail).toBeUndefined()
    const output = result.content ?? ''
    const document = parseDocument(output)
    expect(document.errors).toEqual([])
    expect(document.warnings).toEqual([])
    expect(document.toJS()).toEqual(expected)
    const closingBrace = source.lastIndexOf('}')
    expect(output.startsWith(source.slice(0, closingBrace))).toBe(true)
    expect(output.endsWith(source.slice(closingBrace))).toBe(true)
    if (eol === '\r\n') {
      expect(output.replaceAll(eol, '')).not.toContain('\n')
    }
  })
})
