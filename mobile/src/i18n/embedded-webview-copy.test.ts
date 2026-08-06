import { afterEach, describe, expect, it } from 'vitest'

import {
  buildMobileRichMarkdownEditorHtml,
  escapeInjectedJavaScriptString
} from '../components/mobile-rich-markdown-editor-html'
import { buildTerminalWebViewHtml } from '../terminal/terminal-webview-html'
import { escapeEmbeddedHtmlCopy } from './embedded-webview-copy'
import { mobileI18n } from './mobile-i18n'

const INITIAL_LOCALE = mobileI18n.language

afterEach(async () => {
  await mobileI18n.changeLanguage(INITIAL_LOCALE)
})

describe('embedded WebView copy', () => {
  it('escapes translated HTML text and attributes', () => {
    expect(escapeEmbeddedHtmlCopy('<Copy "all" & more>')).toBe(
      '&lt;Copy &quot;all&quot; &amp; more&gt;'
    )
  })

  it('injects localized rich-editor and terminal controls', async () => {
    await mobileI18n.changeLanguage('es')

    const editorHtml = buildMobileRichMarkdownEditorHtml()
    expect(editorHtml).toContain('<html lang="es">')
    expect(editorHtml).toContain('data-placeholder="Empieza a escribir..."')
    expect(editorHtml).toContain('window.prompt("URL del enlace")')
    expect(editorHtml).toContain('window.prompt("URL de la imagen")')
    expect(editorHtml).toContain(`+ "Tarea" +`)

    const terminalHtml = buildTerminalWebViewHtml()
    expect(terminalHtml).toContain('<html lang="es">')
    expect(terminalHtml).toContain('id="sel-menu-copy">Copiar</button>')
    expect(terminalHtml).toContain('id="sel-menu-all">Seleccionar todo</button>')
  })

  it('escapes script-state delimiters in translated JavaScript strings', () => {
    expect(escapeInjectedJavaScriptString('<!--<script>')).toBe('"\\u003c!--\\u003cscript>"')
  })

  it('HTML-escapes rich-editor placeholders before insertHTML parses them', () => {
    const codePlaceholder = mobileI18n.getResource(
      'en',
      'translation',
      'richMarkdown.codePlaceholder'
    )
    const taskPlaceholder = mobileI18n.getResource(
      'en',
      'translation',
      'richMarkdown.taskPlaceholder'
    )
    mobileI18n.addResource(
      'en',
      'translation',
      'richMarkdown.codePlaceholder',
      '<img src=x onerror=alert(1)>'
    )
    mobileI18n.addResource(
      'en',
      'translation',
      'richMarkdown.taskPlaceholder',
      '<b>Task & more</b>'
    )

    try {
      const editorHtml = buildMobileRichMarkdownEditorHtml()
      expect(editorHtml).toContain('&lt;img src=x onerror=alert(1)&gt;')
      expect(editorHtml).toContain('&lt;b&gt;Task &amp; more&lt;/b&gt;')
      expect(editorHtml).not.toContain('<img src=x onerror=alert(1)>')
      expect(editorHtml).not.toContain('<b>Task & more</b>')
    } finally {
      mobileI18n.addResource('en', 'translation', 'richMarkdown.codePlaceholder', codePlaceholder)
      mobileI18n.addResource('en', 'translation', 'richMarkdown.taskPlaceholder', taskPlaceholder)
    }
  })
})
