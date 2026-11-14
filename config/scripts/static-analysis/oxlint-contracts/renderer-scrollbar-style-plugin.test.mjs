import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { runOxlintPluginOnSources } from './oxlint-plugin-test-runner.mjs'

const pluginPath = path.resolve('config/oxlint-plugins/renderer-scrollbar-style.mjs')

function lintSources(sources) {
  return runOxlintPluginOnSources({
    pluginName: 'renderer-scrollbar-style',
    pluginPath,
    sources,
    rules: {
      'renderer-scrollbar-style/require-styled-vertical-scrollbar': 'warn'
    }
  })
}

const violations = [
  [
    'escaped class expression',
    String.raw`export const X = () => <div className={'\x6fverflow-y-auto'} />`,
    String.raw`'\x6fverflow-y-auto'`
  ],
  [
    'conditional scrollbar',
    "export const X = ({ enabled }) => <div className={cn('overflow-y-auto', enabled && 'scrollbar-sleek')} />",
    "'overflow-y-auto'"
  ],
  [
    'mismatched responsive variants',
    'export const X = () => <div className="overflow-y-auto md:scrollbar-sleek" />',
    '"overflow-y-auto md:scrollbar-sleek"'
  ],
  [
    'logical inline style spread',
    "export const X = ({ open }) => <div style={{ ...(open && { overflowY: 'auto' }) }} />",
    "overflowY: 'auto'"
  ],
  [
    'later spread override',
    'export const X = () => <div className="scrollbar-sleek" {...{ className: \'overflow-y-auto\' }} />',
    "'overflow-y-auto'"
  ]
]

const accepted = [
  [
    'same conditional literal',
    "export const X = ({ enabled }) => <div className={cn(enabled && 'overflow-y-auto scrollbar-sleek')} />"
  ],
  [
    'matching responsive variants',
    'export const X = () => <div className="md:overflow-y-auto md:scrollbar-sleek" />'
  ],
  [
    'styled inline overflow',
    'export const X = () => <div className="scrollbar-editor" style={{ overflow: \'auto\' }} />'
  ],
  [
    'styled JSX spread class',
    "export const X = () => <div {...{ className: 'overflow-y-auto scrollbar-sleek' }} />"
  ]
]

const diagnosticsBySource = new Map()
beforeAll(() => {
  const sources = [...violations, ...accepted].map(([, source]) => source)
  lintSources(sources).forEach((diagnostics, index) => {
    diagnosticsBySource.set(sources[index], diagnostics)
  })
})

describe('renderer scrollbar style Oxlint plugin', () => {
  it.each(violations)('reports %s', (_name, source, reportedSource) => {
    const findings = diagnosticsBySource.get(source)
    expect(findings).toHaveLength(1)
    expect(findings[0].code).toBe('renderer-scrollbar-style(require-styled-vertical-scrollbar)')
    const { offset, length } = findings[0].labels[0].span
    expect(
      Buffer.from(source)
        .subarray(offset, offset + length)
        .toString('utf8')
    ).toBe(reportedSource)
  })

  it.each(accepted)('accepts %s', (_name, source) => {
    expect(diagnosticsBySource.get(source)).toEqual([])
  })
})
