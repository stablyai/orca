import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { runOxlintPluginOnSources } from './oxlint-plugin-test-runner.mjs'

const pluginPath = path.resolve('config/oxlint-plugins/ime-enter-guard.mjs')

function lintSources(sources) {
  return runOxlintPluginOnSources({
    pluginName: 'ime-enter-guard',
    pluginPath,
    sources,
    rules: { 'ime-enter-guard/require-ime-guard': 'warn' }
  })
}

const violations = [
  [
    'inline Enter on a raw input',
    "export const X = () => <input onKeyDown={(e) => { if (e.key === 'Enter') go() }} />"
  ],
  [
    'Enter on a raw textarea',
    "export const X = () => <textarea onKeyDown={(e) => e.key === 'Enter' && send()} />"
  ],
  [
    'Enter by code on a text-typed input',
    'export const X = () => <input type="search" onKeyDown={(e) => { if (e.code === "NumpadEnter") go() }} />'
  ],
  [
    'Enter by keyCode',
    'export const X = () => <input onKeyPress={(e) => { if (e.keyCode === 13) go() }} />'
  ],
  [
    'Enter on a contentEditable element',
    "export const X = () => <div contentEditable onKeyDown={(e) => { if (e.key === 'Enter') go() }} />"
  ],
  [
    'named local handler',
    `export function X() {
      const onKeyDown = (e) => { if (e.key === 'Enter') submit() }
      return <input onKeyDown={onKeyDown} />
    }`
  ],
  [
    'useCallback handler',
    `export function X() {
      const handleKeyDown = useCallback((e) => { if (e.key === 'Enter') submit() }, [])
      return <input onKeyDownCapture={handleKeyDown} />
    }`
  ],
  [
    'keydown listener on an input ref',
    `export function attach(inputRef) {
      inputRef.current.addEventListener('keydown', (e) => { if (e.key === 'Enter') go() })
    }`
  ],
  [
    'keydown listener on a created textarea',
    `export function attach() {
      const el = document.createElement('textarea')
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') go() })
    }`
  ]
]

const accepted = [
  [
    'shared guard inline',
    "export const X = () => <input onKeyDown={(e) => { if (isImeCompositionKeyDown(e)) return; if (e.key === 'Enter') go() }} />"
  ],
  [
    'shared guard in a called helper',
    `function ignoreIme(e) { return isImeOwnedKeyboardEvent(e) }
    export function X() {
      const onKeyDown = (e) => { if (ignoreIme(e)) return; if (e.key === 'Enter') go() }
      return <textarea onKeyDown={onKeyDown} />
    }`
  ],
  [
    'gesture ownership guard',
    "export const X = () => <input onKeyDown={(e) => { if (ime.ownsKeyDown(e)) return; if (e.key === 'Enter') go() }} />"
  ],
  [
    'element tracks composition itself',
    "export const X = () => <input onCompositionStart={start} onKeyDown={(e) => { if (e.key === 'Enter') go() }} />"
  ],
  [
    'Input primitive',
    "export const X = () => <Input onKeyDown={(e) => { if (e.key === 'Enter') go() }} />"
  ],
  [
    'ImeTextarea',
    "export const X = () => <ImeTextarea onKeyDown={(e) => { if (e.key === 'Enter') go() }} />"
  ],
  [
    'non-text input type',
    'export const X = () => <input type="checkbox" onKeyDown={(e) => { if (e.key === "Enter") toggle() }} />'
  ],
  [
    'list row button',
    "export const X = () => <button onKeyDown={(e) => { if (e.key === 'Enter') open() }} />"
  ],
  [
    'contentEditable disabled',
    "export const X = () => <div contentEditable={false} onKeyDown={(e) => { if (e.key === 'Enter') go() }} />"
  ],
  [
    'non-Enter key handling',
    "export const X = () => <input onKeyDown={(e) => { if (e.key === 'Escape') cancel() }} />"
  ],
  [
    'handler passed in from props',
    'export const X = ({ onKeyDown }) => <input onKeyDown={onKeyDown} />'
  ],
  [
    'window keydown listener',
    "export const attach = () => window.addEventListener('keydown', (e) => { if (e.key === 'Enter') go() })"
  ]
]

const diagnosticsBySource = new Map()
beforeAll(() => {
  const sources = [...violations, ...accepted].map(([, source]) => source)
  lintSources(sources).forEach((diagnostics, index) => {
    diagnosticsBySource.set(sources[index], diagnostics)
  })
})

describe('IME Enter guard Oxlint plugin', () => {
  it.each(violations)('reports %s', (_name, source) => {
    expect(diagnosticsBySource.get(source)).toHaveLength(1)
  })

  it.each(accepted)('accepts %s', (_name, source) => {
    expect(diagnosticsBySource.get(source)).toEqual([])
  })
})
