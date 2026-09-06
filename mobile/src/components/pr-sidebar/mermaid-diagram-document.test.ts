import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_MERMAID_FRAME_PATH,
  MOBILE_WEB_MERMAID_FRAME_SCRIPT_CSP_HASH,
  buildMobileWebMermaidFrameDocument
} from '../../../../src/shared/mobile-web/mermaid-frame-document'
import {
  buildMermaidDiagramDocument,
  MERMAID_DIAGRAM_SCRIPT,
  MERMAID_DIAGRAM_SCRIPT_CSP_HASH
} from './mermaid-diagram-document'
import {
  MERMAID_DIAGRAM_ENGINE_CHUNK_CHARACTERS,
  createMermaidDiagramEngineMessages,
  createMermaidDiagramInitializationMessage,
  parseMermaidDiagramMessage
} from './mermaid-diagram-contract'
import {
  MERMAID_WEBVIEW_ENGINE_GZIP_BASE64,
  MERMAID_WEBVIEW_ENGINE_CSP_HASH
} from './mermaid-webview-engine.generated'

function scriptHash(script: string): string {
  return `'sha256-${createHash('sha256').update(script).digest('base64')}'`
}

describe('Mermaid diagram document', () => {
  it('hash-authorizes only the bundled engine and fixed sanitizer runner', () => {
    const payload = '</textarea><script src="https://sentinel.invalid/pwn.js"></script>'
    const document = buildMermaidDiagramDocument(payload, 'frame-token')
    const engine = gunzipSync(Buffer.from(MERMAID_WEBVIEW_ENGINE_GZIP_BASE64, 'base64')).toString()

    expect(MERMAID_WEBVIEW_ENGINE_CSP_HASH).toBe(scriptHash(engine))
    expect(MERMAID_DIAGRAM_SCRIPT_CSP_HASH).toBe(scriptHash(MERMAID_DIAGRAM_SCRIPT))
    expect(document).toContain(
      `script-src ${MERMAID_WEBVIEW_ENGINE_CSP_HASH} ${MERMAID_DIAGRAM_SCRIPT_CSP_HASH}`
    )
    expect(document).toContain("default-src 'none'")
    expect(document).toContain("connect-src 'none'")
    expect(document).toContain("frame-ancestors 'self'")
    expect(document).toContain("worker-src 'none'")
    expect(document).not.toContain(payload)
    expect(document).not.toContain('frame-token')
    expect(document).not.toContain('<script src=')
    expect(document).not.toContain('nonce=')
    expect(document).not.toContain('blob:')
  })

  it('sanitizes generated SVG and disables Mermaid HTML labels and links', () => {
    expect(MERMAID_DIAGRAM_SCRIPT).toContain("securityLevel: 'strict'")
    expect(MERMAID_DIAGRAM_SCRIPT).toContain('htmlLabels: false')
    expect(MERMAID_DIAGRAM_SCRIPT).toContain("FORBID_TAGS: ['a', 'foreignObject', 'script']")
    expect(MERMAID_DIAGRAM_SCRIPT).toContain('container.innerHTML = clean')
  })

  it('emits a fixed private-origin frame without diagram or authority state', () => {
    const document = buildMobileWebMermaidFrameDocument({
      theme: {
        background: '#242424',
        primary: '#1a1a1a',
        text: '#e0e0e0',
        line: '#888888'
      }
    })

    expect(Buffer.byteLength(document)).toBeLessThan(16 * 1024)
    expect(document).not.toContain(MERMAID_WEBVIEW_ENGINE_GZIP_BASE64)
    expect(document).toContain(`script-src ${MOBILE_WEB_MERMAID_FRAME_SCRIPT_CSP_HASH} blob:`)
    expect(document).toContain("frame-ancestors 'self'")
    expect(document).not.toContain('graph TD; A-->B')
    expect(document).not.toContain('frame-token')
    expect(MERMAID_DIAGRAM_SCRIPT.indexOf('window.parent !== window')).toBeLessThan(
      MERMAID_DIAGRAM_SCRIPT.indexOf('window.ReactNativeWebView')
    )
    expect(MERMAID_DIAGRAM_SCRIPT).toContain('event.source !== parent')
    expect(MERMAID_DIAGRAM_SCRIPT).toContain('receiveInitialization')
    expect(MERMAID_DIAGRAM_SCRIPT).toContain('message.chunkCount !== engineChunkCount')
    expect(MERMAID_DIAGRAM_SCRIPT).toContain('message.chunk.length !== expectedLength')
    expect(MERMAID_DIAGRAM_SCRIPT).toContain("new Blob([engine], { type: 'text/javascript' })")
    expect(MERMAID_DIAGRAM_SCRIPT).toContain('URL.revokeObjectURL(scriptUrl)')
    expect(MERMAID_DIAGRAM_SCRIPT).not.toMatch(/\bengine:\s/)
  })

  it('delivers the bundled engine through bounded token-authenticated chunks', () => {
    const messages = createMermaidDiagramEngineMessages(
      MERMAID_WEBVIEW_ENGINE_GZIP_BASE64,
      'frame-token'
    )

    expect(messages).toHaveLength(
      Math.ceil(MERMAID_WEBVIEW_ENGINE_GZIP_BASE64.length / MERMAID_DIAGRAM_ENGINE_CHUNK_CHARACTERS)
    )
    expect(messages.every((message) => message.chunk.length <= 32 * 1024)).toBe(true)
    expect(messages.map((message) => message.chunk).join('')).toBe(
      MERMAID_WEBVIEW_ENGINE_GZIP_BASE64
    )
    expect(messages[0]).toMatchObject({
      channel: 'orca-mobile-mermaid-engine',
      token: 'frame-token',
      chunkIndex: 0,
      chunkCount: messages.length
    })
  })

  it('initializes the fixed frame with bounded source and engine metadata', () => {
    expect(
      createMermaidDiagramInitializationMessage(
        'graph TD; A-->B',
        MERMAID_WEBVIEW_ENGINE_GZIP_BASE64,
        'a'.repeat(32)
      )
    ).toEqual({
      channel: 'orca-mobile-mermaid-init',
      token: 'a'.repeat(32),
      source: 'graph TD; A-->B',
      engineLength: MERMAID_WEBVIEW_ENGINE_GZIP_BASE64.length,
      engineChunkCount: Math.ceil(
        MERMAID_WEBVIEW_ENGINE_GZIP_BASE64.length / MERMAID_DIAGRAM_ENGINE_CHUNK_CHARACTERS
      )
    })
    expect(
      createMermaidDiagramInitializationMessage(
        'a'.repeat(128 * 1024 + 1),
        MERMAID_WEBVIEW_ENGINE_GZIP_BASE64,
        'a'.repeat(32)
      )
    ).toBeNull()
  })

  it('accepts only bounded typed renderer messages', () => {
    expect(
      parseMermaidDiagramMessage({
        channel: 'orca-mobile-mermaid',
        type: 'rendered',
        token: '',
        height: 120.2
      })
    ).toEqual({ type: 'rendered', height: 121 })
    expect(
      parseMermaidDiagramMessage({ channel: 'orca-mobile-mermaid', type: 'error', token: '' })
    ).toEqual({ type: 'error' })
    expect(
      parseMermaidDiagramMessage({ channel: 'orca-mobile-mermaid', type: 'ready', token: '' })
    ).toEqual({ type: 'ready' })
    expect(
      parseMermaidDiagramMessage({ channel: 'orca-mobile-mermaid', type: 'assembled', token: '' })
    ).toEqual({ type: 'assembled' })
    expect(
      parseMermaidDiagramMessage({
        channel: 'orca-mobile-mermaid',
        type: 'rendered',
        token: '',
        height: 10001
      })
    ).toBeNull()
    expect(
      parseMermaidDiagramMessage({ channel: 'orca-mobile-mermaid', type: 'error', token: 'bad' })
    ).toBeNull()
    expect(parseMermaidDiagramMessage({ channel: 'other', type: 'error', token: '' })).toBeNull()
    expect(parseMermaidDiagramMessage('{')).toBeNull()
  })
})

describe('Mermaid diagram platform sources', () => {
  const nativeSource = readFileSync(new URL('./MermaidDiagram.tsx', import.meta.url), 'utf8')
  const webSource = readFileSync(new URL('./MermaidDiagram.web.tsx', import.meta.url), 'utf8')
  const presentationSource = readFileSync(
    new URL('./mermaid-diagram-presentation.tsx', import.meta.url),
    'utf8'
  )

  it('shares the existing diagram/fallback presentation', () => {
    expect(nativeSource).toContain('<MermaidDiagramPresentation')
    expect(webSource).toContain('<MermaidDiagramPresentation')
    expect(presentationSource).toContain('<Text style={styles.labelText}>mermaid</Text>')
  })

  it('locks the native WebView to the bundled network-denied document', () => {
    expect(nativeSource).toContain("originWhitelist={['about:blank']}")
    expect(nativeSource).toContain('allowFileAccess={false}')
    expect(nativeSource).toContain('allowUniversalAccessFromFileURLs={false}')
    expect(nativeSource).not.toContain("originWhitelist={['*']}")
    expect(nativeSource).not.toContain('cdn.jsdelivr.net')
  })

  it('uses a token-bound, no-same-origin document frame for RNW', () => {
    expect(webSource).toContain(`src={\`/\${MOBILE_WEB_MERMAID_FRAME_PATH}\`}`)
    expect(webSource).toContain('MOBILE_WEB_MERMAID_FRAME_PATH')
    expect(MOBILE_WEB_MERMAID_FRAME_PATH).toBe('mermaid-frame.html')
    expect(webSource).not.toContain('data:text/html;charset=utf-8,')
    expect(webSource).not.toContain('srcDoc=')
    expect(webSource).toContain('sandbox="allow-scripts"')
    expect(webSource).not.toContain('allow-same-origin')
    expect(webSource).toContain('crypto.getRandomValues(bytes)')
    expect(webSource).not.toContain('event.origin')
    expect(webSource).toContain('event.source !== frameRef.current?.contentWindow')
    expect(webSource).toContain('parseMermaidDiagramMessage(event.data, frameToken)')
    expect(webSource).toContain('createMermaidDiagramInitializationMessage')
    expect(webSource).toContain('createMermaidDiagramEngineMessages')
    expect(webSource).toContain("setFrameStatus('loaded')")
    expect(webSource).toContain('data-orca-mermaid-status={frameStatus}')
    expect(webSource).toContain('[0, 250, 1_000].map')
  })
})
