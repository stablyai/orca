import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { plainClassName } from '../oxlint-plugins/renderer-scrollbar-style.mjs'
import { runOxlintPluginOnSource } from './oxlint-plugin-test-runner.mjs'

const pluginPath = path.resolve('config/oxlint-plugins/renderer-scrollbar-style.mjs')

function lintSource(source) {
  return runOxlintPluginOnSource({
    pluginName: 'renderer-scrollbar-style',
    pluginPath,
    source,
    rules: {
      'renderer-scrollbar-style/require-styled-vertical-scrollbar': 'warn'
    }
  })
}

const violations = [
  ['unstyled class', 'export const X = () => <div className="max-h-64 overflow-y-auto" />'],
  [
    'unstyled suffix-important class',
    'export const X = () => <div className="max-h-64 overflow-y-auto!" />'
  ],
  [
    'unknown scrollbar class',
    'export const X = () => <div className="overflow-auto scrollbar-none" />'
  ],
  [
    'separate class composer arguments',
    "export const X = () => <div className={cn('overflow-y-auto', 'scrollbar-sleek')} />"
  ],
  [
    'conditional scrollbar',
    "export const X = ({ enabled }) => <div className={cn('overflow-y-auto', enabled && 'scrollbar-sleek')} />"
  ],
  [
    'arbitrary class wrapper',
    "export const X = () => <div className={identity('overflow-y-auto')} />"
  ],
  [
    'mismatched responsive variants',
    'export const X = () => <div className="overflow-y-auto md:scrollbar-sleek" />'
  ],
  ['inline overflow', "export const X = () => <div style={{ overflowY: 'auto' }} />"],
  [
    'logical inline style spread',
    "export const X = ({ open }) => <div style={{ ...(open && { overflowY: 'auto' }) }} />"
  ],
  ['JSX spread class', "export const X = () => <div {...{ className: 'overflow-y-auto' }} />"],
  [
    'later spread override',
    'export const X = () => <div className="scrollbar-sleek" {...{ className: \'overflow-y-auto\' }} />'
  ]
]

const accepted = [
  [
    'styled vertical class',
    'export const X = () => <div className="overflow-auto scrollbar-sleek" />'
  ],
  [
    'styled suffix-important classes',
    'export const X = () => <div className="overflow-y-auto! scrollbar-sleek!" />'
  ],
  [
    'same composer literal',
    "export const X = () => <div className={cn('overflow-y-auto scrollbar-sleek')} />"
  ],
  [
    'same conditional literal',
    "export const X = ({ enabled }) => <div className={cn(enabled && 'overflow-y-auto scrollbar-sleek')} />"
  ],
  ['horizontal-only overflow', 'export const X = () => <pre className="overflow-x-auto" />'],
  [
    'matching responsive variants',
    'export const X = () => <div className="md:overflow-y-auto md:scrollbar-sleek" />'
  ],
  [
    'unconditional scrollbar',
    'export const X = () => <div className="md:overflow-y-auto scrollbar-sleek" />'
  ],
  [
    'styled inline overflow',
    'export const X = () => <div className="scrollbar-editor" style={{ overflow: \'auto\' }} />'
  ],
  [
    'styled JSX spread class',
    "export const X = () => <div {...{ className: 'overflow-y-auto scrollbar-sleek' }} />"
  ],
  [
    'variant configuration',
    "export const X = () => <div className={buttonVariants({ className: 'overflow-y-auto scrollbar-sleek' })} />"
  ]
]

describe('renderer scrollbar style Oxlint plugin', () => {
  it.each(violations)('reports %s', (_name, source) => {
    expect(lintSource(source)).toHaveLength(1)
  })

  it.each(accepted)('accepts %s', (_name, source) => {
    expect(lintSource(source)).toEqual([])
  })

  it.each([
    ['md:overflow-y-auto', 'overflow-y-auto'],
    ['[&:hover]:overflow-y-auto', 'overflow-y-auto'],
    ['md:!scrollbar-editor', 'scrollbar-editor'],
    ['!scrollbar-editor', 'scrollbar-editor'],
    ['overflow-y-auto!', 'overflow-y-auto'],
    ['md:scrollbar-editor!', 'scrollbar-editor']
  ])('normalizes %s', (token, expected) => {
    expect(plainClassName(token)).toBe(expected)
  })
})
