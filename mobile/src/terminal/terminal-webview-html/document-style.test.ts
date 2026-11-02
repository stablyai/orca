import { describe, expect, it } from 'vitest'
import { documentLevelRules, scopeStyleToHost } from '../../style-scoping/document-style-scoping'
import { XTERM_ENGINE_CSS } from '../terminal-webview-engine-css.generated'
import { TERMINAL_DOCUMENT_ELEMENT_STYLE, TERMINAL_DOCUMENT_ROOT_STYLE } from './document-style'

// Verify native root rules remain separate while page-injected rules can reach only terminal-owned elements.
const PREFIX = '.orca-terminal-document-host'

function selectorsOf(css: string): string[] {
  return [...css.matchAll(/(?:^|\})\s*([^{}]+)\{/g)].flatMap((match) =>
    match[1]!.split(',').map((one) => one.trim())
  )
}

describe('the terminal document stylesheet', () => {
  it('keeps every document-level rule out of the half the page takes', () => {
    expect(documentLevelRules(TERMINAL_DOCUMENT_ROOT_STYLE)).toEqual(['*', 'html, body'])
    expect(documentLevelRules(TERMINAL_DOCUMENT_ELEMENT_STYLE)).toEqual([])
  })

  it('holds every selector of both injected sheets under the host', () => {
    for (const sheet of [TERMINAL_DOCUMENT_ELEMENT_STYLE, XTERM_ENGINE_CSS]) {
      const scoped = scopeStyleToHost(sheet, PREFIX)
      const selectors = selectorsOf(scoped)
      expect(selectors.length).toBeGreaterThan(0)
      expect(selectors.filter((one) => !one.startsWith(`${PREFIX} `))).toEqual([])
    }
  })

  it('drops a document-level rule rather than prefixing it', () => {
    const scoped = scopeStyleToHost(TERMINAL_DOCUMENT_ROOT_STYLE, PREFIX)
    expect(scoped.trim()).toBe('')
  })
})
