import { describe, expect, it } from 'vitest'
import { isMap, parseDocument } from 'yaml'
import { enablePlugin, updateConfigContent } from './hermes-config-yaml'

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

describe.each(['\n', '\r\n'])('Hermes flow insertion with tab separation (%j)', (eol) => {
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
