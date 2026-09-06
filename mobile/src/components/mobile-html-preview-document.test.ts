// @vitest-environment jsdom

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { readMobileSessionRouteSourceFamily } from '../session/mobile-session-route-source-family.test-support'
import {
  buildMobileHtmlPreviewDocument,
  MOBILE_HTML_PREVIEW_MESSAGE_CHANNEL,
  MOBILE_HTML_PREVIEW_SCRIPT,
  MOBILE_HTML_PREVIEW_SCRIPT_CSP_HASH,
  parseMobileHtmlPreviewMessage
} from './mobile-html-preview-document'

function executePreviewDocument(
  html: string,
  frameToken = ''
): {
  document: Document
  postMessage: ReturnType<typeof vi.fn>
} {
  const shell = buildMobileHtmlPreviewDocument(html)
  const withoutScript = shell.replace(`<script>${MOBILE_HTML_PREVIEW_SCRIPT}</script>`, '')
  const previewDocument = new DOMParser().parseFromString(withoutScript, 'text/html')
  const postMessage = vi.fn()
  const previewWindow = {
    name: frameToken,
    ReactNativeWebView: { postMessage }
  }
  new Function('document', 'window', MOBILE_HTML_PREVIEW_SCRIPT)(previewDocument, previewWindow)
  return { document: previewDocument, postMessage }
}

describe('mobile HTML preview document', () => {
  it('hashes the only executable script and keeps repository HTML out of source markup', () => {
    const payload = '</textarea><script>globalThis.pwned=true</script>'
    const shell = buildMobileHtmlPreviewDocument(payload)
    const scriptHash = `'sha256-${createHash('sha256')
      .update(MOBILE_HTML_PREVIEW_SCRIPT)
      .digest('base64')}'`

    expect(MOBILE_HTML_PREVIEW_SCRIPT_CSP_HASH).toBe(scriptHash)
    expect(shell).toContain(`script-src ${scriptHash}`)
    expect(shell).toContain("default-src 'none'")
    expect(shell).toContain("connect-src 'none'")
    expect(shell).toContain('img-src data: https:')
    expect(shell).not.toContain(payload)
    expect(shell.match(/<script>/g)).toHaveLength(1)
  })

  it('renders the HTML and SVG corpus without executable content or network-bearing URLs', () => {
    const sentinel = 'https://sentinel.invalid/escape'
    const { document } = executePreviewDocument(`
      <style>.safe { color: red }</style>
      <style>@import "${sentinel}/style.css";</style>
      <h1 class="safe" onclick="globalThis.pwned=true">Report</h1>
      <script>globalThis.pwned=true</script>
      <iframe src="${sentinel}/frame"></iframe>
      <meta http-equiv="refresh" content="0;url=${sentinel}/refresh">
      <form action="${sentinel}/form"><input autofocus></form>
      <svg onload="globalThis.pwned=true"><foreignObject>bad</foreignObject></svg>
      <math><mtext>bad</mtext></math>
      <img id="remote" src="http://sentinel.invalid/escape/image.png" onerror="globalThis.pwned=true">
      <img id="svg" src="data:image/svg+xml,&lt;svg onload=alert(1)&gt;">
      <img id="raster" src="data:image/png;base64,iVBORw0KGgo=" alt="safe raster">
      <a id="javascript" href="javascript:alert(1)">bad scheme</a>
      <a id="data" href="data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;">bad data</a>
      <a id="safe" href="https://example.com/path">safe link</a>
      <custom-element><p id="unwrapped">Readable custom content</p></custom-element>
    `)
    const preview = document.getElementById('preview')!

    expect(preview.textContent).toContain('Report')
    expect(preview.textContent).toContain('Readable custom content')
    expect(preview.querySelector('script,iframe,meta,form,input,svg,math')).toBeNull()
    expect(preview.innerHTML).not.toContain(sentinel)
    expect(preview.innerHTML).not.toMatch(/\son[a-z]+=/i)
    expect(preview.querySelector('#remote')?.hasAttribute('src')).toBe(false)
    expect(preview.querySelector('#svg')?.hasAttribute('src')).toBe(false)
    expect(preview.querySelector('#raster')?.getAttribute('src')).toBe(
      'data:image/png;base64,iVBORw0KGgo='
    )
    expect(preview.querySelector('#javascript')?.hasAttribute('href')).toBe(false)
    expect(preview.querySelector('#data')?.hasAttribute('href')).toBe(false)
    expect(preview.querySelector('#safe')?.getAttribute('href')).toBe('https://example.com/path')
    expect(preview.querySelectorAll('style')).toHaveLength(1)
  })

  it('keeps https images the preview policy admits and drops plaintext http ones', () => {
    const shell = buildMobileHtmlPreviewDocument('')
    const { document } = executePreviewDocument(
      [
        '<img id="secure" src="https://example.com/image.png" alt="remote">',
        '<img id="plaintext" src="http://example.com/image.png">',
        '<img id="relative" src="/image.png">'
      ].join('\n')
    )
    const preview = document.getElementById('preview')!
    const imgSrc = shell.match(/img-src ([^;"]+)/)?.[1] ?? ''

    expect(preview.querySelector('#secure')?.getAttribute('src')).toBe(
      'https://example.com/image.png'
    )
    expect(preview.querySelector('#secure')?.getAttribute('alt')).toBe('remote')
    expect(preview.querySelector('#plaintext')?.hasAttribute('src')).toBe(false)
    expect(preview.querySelector('#relative')?.hasAttribute('src')).toBe(false)
    expect(imgSrc.split(' ')).toEqual(['data:', 'https:'])
  })

  it('emits only a token-bound HTTP(S) link message after a sanitized link click', () => {
    const { document, postMessage } = executePreviewDocument(
      '<a id="safe" href="https://example.com/path">safe</a>',
      'frame-token'
    )
    document.getElementById('safe')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(postMessage).toHaveBeenCalledOnce()
    expect(parseMobileHtmlPreviewMessage(postMessage.mock.calls[0]?.[0], 'frame-token')).toBe(
      'https://example.com/path'
    )
    expect(parseMobileHtmlPreviewMessage(postMessage.mock.calls[0]?.[0], 'wrong-token')).toBeNull()
  })

  it('rejects malformed, extra-scheme, oversized, and unauthenticated messages', () => {
    const message = (url: string, token = '') =>
      JSON.stringify({
        channel: MOBILE_HTML_PREVIEW_MESSAGE_CHANNEL,
        type: 'openExternal',
        token,
        url
      })

    expect(parseMobileHtmlPreviewMessage(message('http://example.com'))).toBe('http://example.com')
    expect(parseMobileHtmlPreviewMessage(message('javascript:alert(1)'))).toBeNull()
    expect(parseMobileHtmlPreviewMessage(message('data:text/html,bad'))).toBeNull()
    expect(
      parseMobileHtmlPreviewMessage(message(`https://example.com/${'x'.repeat(4096)}`))
    ).toBeNull()
    expect(parseMobileHtmlPreviewMessage(message('https://example.com', 'token'))).toBeNull()
    expect(parseMobileHtmlPreviewMessage('{')).toBeNull()
    expect(parseMobileHtmlPreviewMessage(null)).toBeNull()
  })
})

describe('mobile HTML preview platform sources', () => {
  const nativeSource = readFileSync('src/components/MobileHtmlPreview.tsx', 'utf8')
  const webSource = readFileSync('src/components/MobileHtmlPreview.web.tsx', 'utf8')
  const presentationSource = readFileSync(
    'src/components/mobile-html-preview-presentation.tsx',
    'utf8'
  )

  it('shares the unchanged Preview/Source presentation across native and RNW', () => {
    expect(nativeSource).toContain('<MobileHtmlPreviewPresentation')
    expect(webSource).toContain('<MobileHtmlPreviewPresentation')
    expect(presentationSource).toContain('Preview rendered HTML')
    expect(presentationSource).toContain('View HTML source')
    expect(nativeSource).not.toContain('Preview rendered HTML')
    expect(webSource).not.toContain('Preview rendered HTML')
  })

  it('locks the native nested WebView to its sanitizer document and message bridge', () => {
    expect(nativeSource).toContain("originWhitelist={['about:blank']}")
    expect(nativeSource).toContain('source={{ html: document }}')
    expect(nativeSource).toContain('javaScriptCanOpenWindowsAutomatically={false}')
    expect(nativeSource).toContain('allowFileAccess={false}')
    expect(nativeSource).toContain('allowUniversalAccessFromFileURLs={false}')
    expect(nativeSource).toContain('parseMobileHtmlPreviewMessage(event.nativeEvent.data)')
    expect(nativeSource).toContain('onOpenLink?.(url)')
    expect(nativeSource).not.toContain("originWhitelist={['*']}")
    expect(nativeSource).not.toContain('Linking.openURL')
  })

  it('uses a token-bound, no-same-origin data frame for RNW', () => {
    expect(webSource).toContain('data:text/html;charset=utf-8,')
    expect(webSource).toContain('sandbox="allow-scripts"')
    expect(webSource).not.toContain('allow-same-origin')
    expect(webSource).toContain('event.source !== frameRef.current?.contentWindow')
    expect(webSource).toContain('parseMobileHtmlPreviewMessage(event.data, frameToken)')
    expect(webSource).toContain('onOpenLink?.(url)')
    expect(webSource).not.toContain('window.open')
  })

  it('routes HTML preview links through the session device capability', () => {
    const sessionSource = readMobileSessionRouteSourceFamily()

    expect(sessionSource).toContain('onOpenLink={onOpenExternalUrl}')
    expect(sessionSource).toContain('sessionDeviceOperations?.openExternalUrl(url)')
  })
})
