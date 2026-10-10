import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runOxlintPluginOnSource } from './oxlint-plugin-test-runner.mjs'

const pluginPath = path.resolve('config/oxlint-plugins/native-chat-design-tokens.mjs')

function lintSource(source) {
  return runOxlintPluginOnSource({
    pluginName: 'native-chat-design-tokens',
    pluginPath,
    source,
    rules: {
      'native-chat-design-tokens/no-arbitrary-font-size': 'warn',
      'native-chat-design-tokens/no-softened-foreground': 'warn',
      'native-chat-design-tokens/no-weakened-focus-ring': 'warn'
    }
  })
}

const violations = [
  ['arbitrary px size', 'export const X = () => <p className="truncate text-[13px]" />'],
  ['arbitrary rem size', 'export const X = () => <p className="text-[0.8125rem]" />'],
  ['arbitrary size behind a variant', 'export const X = () => <p className="sm:text-[11px]" />'],
  ['arbitrary size in a class constant', "const ROW = 'flex text-[10px]'"],
  [
    'arbitrary size in a composer',
    "export const X = () => <p className={cn(a && 'text-[12px]')} />"
  ],
  ['softened foreground', 'export const X = () => <p className="text-foreground/85" />'],
  [
    'weakened focus ring',
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

describe('native-chat-design-tokens oxlint plugin', () => {
  it.each(violations)('reports %s', (_name, source) => {
    expect(lintSource(source)).toHaveLength(1)
  })

  it.each(accepted)('accepts %s', (_name, source) => {
    expect(lintSource(source)).toEqual([])
  })
})
