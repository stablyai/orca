import { describe, expect, it } from 'vitest'
import {
  buildMobileRichMarkdownEditorHtml,
  escapeInjectedJavaScriptString
} from './mobile-rich-markdown-editor-html'

/**
 * The page the WebView loads, as a page.
 *
 * What the document *does* is asserted where it lives, against the modules under `rich-markdown/`
 * and against the bundle those modules build; this file is about the HTML around it. It used to
 * carry both, by extracting named functions out of the emitted script with `new Function` — a
 * harness the bundle ends, because esbuild renames what collides and the functions now take the
 * scope as their first argument. Every one of those assertions moved to a module test beside the
 * code it is about, which is where the readers of this file would look for them anyway.
 */
function editorScript(): string {
  const script = buildMobileRichMarkdownEditorHtml().match(/<script>([\s\S]*)<\/script>/)?.[1]
  expect(script).toBeTruthy()
  return script ?? ''
}

describe('mobile rich markdown editor HTML', () => {
  it('builds parseable WebView JavaScript', () => {
    expect(() => new Function(editorScript())).not.toThrow()
  })

  it('carries the editable surface the document reaches for, once', () => {
    const html = buildMobileRichMarkdownEditorHtml()
    expect(html).toContain('<main id="editor" contenteditable="true"')
    expect(html.split('id="editor"')).toHaveLength(2)
  })

  it('declares the theme variables its stylesheet reads', () => {
    // The document's colours are the app's own, interpolated when the page is built; a variable
    // the stylesheet uses and the `:root` block never declares renders as nothing at all.
    const style = buildMobileRichMarkdownEditorHtml().match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? ''
    const declared = new Set([...style.matchAll(/^\s*(--[a-z-]+):/gm)].map((match) => match[1]))
    const used = new Set([...style.matchAll(/var\((--[a-z-]+)\)/g)].map((match) => match[1]))
    expect([...used].filter((name) => !declared.has(name))).toEqual([])
    expect(declared.size).toBeGreaterThan(0)
  })

  it('escapes injected markdown without reopening script tags', () => {
    const escaped = escapeInjectedJavaScriptString('</script><script>alert(1)</script>')

    expect(escaped).not.toContain('</script>')
    expect(JSON.parse(escaped.replace(/<\\\/script/gi, '</script'))).toBe(
      '</script><script>alert(1)</script>'
    )
  })

  it('reaches the document through the handle the escaping is for', () => {
    // The native transport is a script evaluated in this page, so the only untrusted text that
    // crosses into it is what goes through the escape above.
    expect(editorScript()).toContain('window.__orcaRichMarkdown =')
  })
})
