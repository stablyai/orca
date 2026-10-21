import { describe, expect, it } from 'vitest'
import { isMap, parseDocument } from 'yaml'
import { enablePlugin, updateConfigContent } from './hermes-config-yaml'

const pluginEntries = [
  { name: 'empty', text: ' # empty,\n', expected: {} },
  { name: 'nonempty', text: 'custom: keep # note\n', expected: { custom: 'keep' } },
  {
    name: 'trailing comma',
    text: 'custom: keep, # separator,\n',
    expected: { custom: 'keep' }
  },
  {
    name: 'comment comma',
    text: 'custom: keep # no separator,\n',
    expected: { custom: 'keep' }
  },
  {
    name: 'nested commas',
    text: 'custom: {names: ["a,", b,],} # nested,\n',
    expected: { custom: { names: ['a,', 'b'] } }
  },
  {
    name: 'explicit entry key',
    text: '? custom : keep # explicit,\n',
    expected: { custom: 'keep' }
  }
]

const contexts = [
  { name: 'block root', prefix: 'plugins: {', suffix: '} # outside' },
  {
    name: 'indented block root',
    prefix: '    model: "001" # before\n    plugins: {',
    suffix: '    } # outside\n    prompt: |-\n      Keep this text',
    settings: { model: '001', prompt: 'Keep this text' }
  },
  { name: 'explicit plugins key', prefix: '? "plugins"\n: {', suffix: '} # outside' },
  {
    name: 'indented explicit plugins key',
    prefix: '    ? plugins\n    : {',
    suffix: '    } # outside'
  },
  { name: 'flow on next line', prefix: 'plugins:\n    {', suffix: '} # outside' },
  {
    name: 'nested in root flow',
    prefix: '{model: "001", plugins: {',
    suffix: '}, extra: [one, two,]} # outside',
    settings: { model: '001', extra: ['one', 'two'] }
  }
]

function expectInsertion(source: string, expected: unknown, eol: string): string {
  const original = parseDocument(source)
  expect(original.errors).toEqual([])
  expect(original.warnings).toEqual([])
  const plugins = original.get('plugins', true)
  const parent = isMap(plugins) ? plugins : original.contents
  if (!isMap(parent) || !parent.range) {
    throw new Error('Fixture must contain a ranged mapping')
  }
  const position = parent.range[1] - 1
  const result = updateConfigContent(source, enablePlugin)
  expect(result.detail).toBeUndefined()
  const output = result.content ?? ''
  const document = parseDocument(output)
  expect(document.errors).toEqual([])
  expect(document.warnings).toEqual([])
  expect(document.toJS()).toEqual(expected)
  expect(output.startsWith(source.slice(0, position))).toBe(true)
  expect(output.endsWith(source.slice(position))).toBe(true)
  expect(updateConfigContent(output, enablePlugin)).toEqual({ content: output })
  if (eol === '\r\n') {
    expect(output.replaceAll(eol, '')).not.toContain('\n')
  }
  return output
}

describe.each(['\n', '\r\n'])('Hermes flow insertion indentation (%j)', (eol) => {
  describe.each([false, true])('final newline = %j', (finalNewline) => {
    describe.each(contexts)('$name', ({ prefix, suffix, settings }) => {
      it.each(pluginEntries)('$name plugin map', ({ text, expected }) => {
        const source = `${prefix}${text}${suffix}${finalNewline ? '\n' : ''}`.replaceAll('\n', eol)
        expectInsertion(
          source,
          { ...settings, plugins: { ...expected, enabled: ['orca-status'] } },
          eol
        )
      })
    })

    it.each([
      { name: 'empty root', text: '{ # empty,\n}', expected: {} },
      { name: 'nonempty root', text: '{model: "001" # note,\n}', expected: { model: '001' } },
      {
        name: 'indented root with nested trailing comma',
        text: '    {model: {names: ["a,", b,],}, # separator,\n}',
        expected: { model: { names: ['a,', 'b'] } }
      }
    ])('$name flow map', ({ text, expected }) => {
      const source = `${text}${finalNewline ? '\n' : ''}`.replaceAll('\n', eol)
      expectInsertion(source, { ...expected, plugins: { enabled: ['orca-status'] } }, eol)
    })
  })
})

describe.each(['\n', '\r\n'])('Hermes flow insertion with tab separation (%j)', (eol) => {
  it.each(pluginEntries.slice(0, 3))('$name map after a tab', ({ text, expected }) => {
    const source = `plugins: {${text}\t}`.replaceAll('\n', eol)
    expectInsertion(source, { plugins: { ...expected, enabled: ['orca-status'] } }, eol)
  })

  it.each([
    {
      name: 'minimal tab',
      source: 'plugins: {custom: keep # note\n\t}',
      padding: '\n '
    },
    {
      name: 'deeper escaped quoted key',
      source: '    "plu\\u0067ins": {custom: keep # note\n    \t}',
      padding: '\n     '
    },
    {
      name: 'mixed spaces and tabs below required indentation',
      source: '    plugins: {custom: keep # note\n    \t  \t }',
      padding: '\n     '
    },
    {
      name: 'whitespace-only closing line',
      source: 'plugins: {custom: keep # note\n\t \t  }',
      padding: '\n '
    },
    {
      name: 'sufficient spaces before a tab',
      source: 'plugins: {custom: keep # note\n \t}',
      padding: ''
    },
    {
      name: 'deeper sufficient spaces before mixed separation',
      source: '    plugins: {custom: keep # note\n     \t \t}',
      padding: ''
    },
    {
      name: 'root flow with zero required indentation',
      source: '    {plugins: {custom: keep # note\n\t}}',
      padding: ''
    },
    {
      name: 'tab after content on the same line',
      source: 'plugins: {custom: keep\t}',
      padding: ''
    },
    {
      name: 'explicit plugins key',
      source: '? "plugins"\n: {custom: keep # note\n\t}',
      padding: '\n '
    },
    {
      name: 'deeper split explicit key',
      source: '    ?\n        "plugins"\n    : {custom: keep # note\n    \t}',
      padding: '\n     '
    }
  ])('preserves source around $name', ({ source: input, padding }) => {
    const source = input.replaceAll('\n', eol)
    const output = expectInsertion(
      source,
      { plugins: { custom: 'keep', enabled: ['orca-status'] } },
      eol
    )
    const insertion = `${padding}, enabled: [ orca-status ]`.replaceAll('\n', eol)
    expect(output).toBe(source.replace('}', `${insertion}}`))
  })

  it('rejects an unrelated value change after repairing tab-separated insertion', () => {
    const source = 'model: "001"\nplugins: {custom: keep # note\n\t}'.replaceAll('\n', eol)
    expect(
      updateConfigContent(source, (config) => ({ ...enablePlugin(config), model: 'changed' }))
    ).toEqual({
      content: null,
      detail: 'Hermes plugin update would change unrelated configuration'
    })
  })
})
