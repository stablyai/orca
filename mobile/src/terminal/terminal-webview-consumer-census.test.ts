import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Nothing above the terminal component knows which of the two it has.
 *
 * The page's `TerminalWebView.web.tsx` is resolved by the bundler, not chosen by a caller, so the
 * whole substitution rests on every consumer holding only `terminal-webview-contract` — the props
 * and the handle — and on the one that renders the component naming it without an extension. A
 * consumer that reached into `TerminalWebView.tsx` for a type, or imported `terminal-webview-html`
 * for the document string, would work natively and break on the page in a way no native test sees.
 *
 * Scanned rather than listed, so a new consumer joins the rule by existing.
 */

const terminalDir = import.meta.dirname
const sessionDir = join(terminalDir, '..', 'session')

/** The modules that may reach into the component's own file or the document's HTML. */
const ALLOWED_INSIDE_TERMINAL = new Set([
  'TerminalWebView.tsx',
  'TerminalWebView.web.tsx',
  'terminal-web-document-mount.ts',
  'terminal-webview-html.ts',
  'terminal-webview-html.web.ts',
  // Test scaffolding that runs the WebView's own document text; it is not shipped in either build.
  'terminal-webview-mouse-test-harness.ts'
])

const FORBIDDEN_ABOVE_THE_CONTRACT = [
  /from '(\.\.\/terminal|\.)\/TerminalWebView\.(web\.)?tsx?'/,
  /from '(\.\.\/terminal|\.)\/terminal-webview-html'/,
  /from '(\.\.\/terminal|\.)\/terminal-webview-engine(-css)?\.generated'/,
  /from '(\.\.\/terminal|\.)\/document\//
]

function productModules(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => /\.tsx?$/.test(name))
    .filter((name) => !name.includes('.test') && !name.includes('.test-support'))
    .sort()
}

function offenders(directory: string, skip: (name: string) => boolean): string[] {
  const found: string[] = []
  for (const name of productModules(directory)) {
    if (skip(name)) {
      continue
    }
    const source = readFileSync(join(directory, name), 'utf8')
    for (const pattern of FORBIDDEN_ABOVE_THE_CONTRACT) {
      if (pattern.test(source)) {
        found.push(`${name}: ${pattern.source}`)
      }
    }
  }
  return found
}

describe('the terminal component contract', () => {
  it('is all that src/session imports of the terminal', () => {
    expect(offenders(sessionDir, () => false)).toEqual([])
    // The precondition: a scan that read no session module would report nothing either.
    const rendering = readFileSync(join(sessionDir, 'TerminalPaneView.tsx'), 'utf8')
    expect(rendering).toContain("from '../terminal/TerminalWebView'")
    expect(rendering).toContain("from '../terminal/terminal-webview-contract'")
  })

  it('is all that the terminal directory itself imports, outside the component and its document', () => {
    expect(offenders(terminalDir, (name) => ALLOWED_INSIDE_TERMINAL.has(name))).toEqual([])
    expect(productModules(terminalDir).length).toBeGreaterThan(40)
  })

  it('would report a consumer that named the component file', () => {
    // The scan tested on the text it is meant to refuse, so an empty offender list above is a
    // measurement rather than a regex that matches nothing.
    const planted = "import { TerminalWebView } from '../terminal/TerminalWebView.tsx'\n"
    expect(FORBIDDEN_ABOVE_THE_CONTRACT.some((pattern) => pattern.test(planted))).toBe(true)
    const html = "import { XTERM_HTML } from '../terminal/terminal-webview-html'\n"
    expect(FORBIDDEN_ABOVE_THE_CONTRACT.some((pattern) => pattern.test(html))).toBe(true)
    const extensionless = "import { TerminalWebView } from '../terminal/TerminalWebView'\n"
    expect(FORBIDDEN_ABOVE_THE_CONTRACT.some((pattern) => pattern.test(extensionless))).toBe(false)
  })
})
