import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { runOxlintPluginOnSources } from './oxlint-plugin-test-runner.mjs'

const pluginPath = path.resolve('config/oxlint-plugins/native-chat-design-tokens.mjs')

function lintSources(sources) {
  return runOxlintPluginOnSources({
    pluginName: 'native-chat-design-tokens',
    pluginPath,
    sources,
    rules: {
      'native-chat-design-tokens/no-arbitrary-font-size': 'warn',
      'native-chat-design-tokens/no-softened-foreground': 'warn',
      'native-chat-design-tokens/no-weakened-focus-ring': 'warn'
    }
  })
}

const violations = [
  [
    'arbitrary px size',
    'native-chat-design-tokens(no-arbitrary-font-size)',
    'export const X = () => <p className="truncate text-[13px]" />'
  ],
  [
    'arbitrary rem size',
    'native-chat-design-tokens(no-arbitrary-font-size)',
    'export const X = () => <p className="text-[0.8125rem]" />'
  ],
  [
    'arbitrary size behind a variant',
    'native-chat-design-tokens(no-arbitrary-font-size)',
    'export const X = () => <p className="sm:text-[11px]" />'
  ],
  [
    'arbitrary size in a class constant',
    'native-chat-design-tokens(no-arbitrary-font-size)',
    "const ROW = 'flex text-[10px]'"
  ],
  [
    'arbitrary size in a composer',
    'native-chat-design-tokens(no-arbitrary-font-size)',
    "export const X = () => <p className={cn(a && 'text-[12px]')} />"
  ],
  [
    'softened foreground',
    'native-chat-design-tokens(no-softened-foreground)',
    'export const X = () => <p className="text-foreground/85" />'
  ],
  [
    'weakened focus ring',
    'native-chat-design-tokens(no-weakened-focus-ring)',
    'export const X = () => <button className="focus-visible:ring-2 focus-visible:ring-ring/70" />'
  ]
]

const accepted = [
  ['named steps', 'export const X = () => <p className="text-sm text-xs text-2xs text-3xs" />'],
  ['code step', 'export const X = () => <pre className="font-mono text-chat-code" />'],
  [
    'arbitrary colour',
    'export const X = () => <p className="text-[var(--git-decoration-added)]" />'
  ],
  [
    'arbitrary non-font length',
    'export const X = () => <p className="min-h-[26px] max-w-[80%]" />'
  ],
  [
    'chat and surface text colours',
    'export const X = () => <p className="text-chat-foreground text-foreground" />'
  ],
  ['softened state colour', 'export const X = () => <p className="text-destructive/80" />'],
  [
    'full focus ring',
    'export const X = () => <button className="focus-visible:ring-2 focus-visible:ring-ring" />'
  ]
]

const diagnosticsBySource = new Map()
beforeAll(() => {
  const sources = [
    ...violations.map(([, , source]) => source),
    ...accepted.map(([, source]) => source)
  ]
  lintSources(sources).forEach((diagnostics, index) => {
    diagnosticsBySource.set(sources[index], diagnostics)
  })
})

describe('native-chat-design-tokens oxlint plugin', () => {
  it.each(violations)('reports %s', (_name, rule, source) => {
    expect(diagnosticsBySource.get(source).map((diagnostic) => diagnostic.code)).toEqual([rule])
  })

  it.each(accepted)('accepts %s', (_name, source) => {
    expect(diagnosticsBySource.get(source)).toEqual([])
  })
})
