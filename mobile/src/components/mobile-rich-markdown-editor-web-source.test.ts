import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readMobileSessionRouteSourceFamily } from '../session/mobile-session-route-source-family.test-support'

const nativeEditor = readFileSync(
  new URL('./MobileRichMarkdownEditor.tsx', import.meta.url),
  'utf8'
)
const webEditor = readFileSync(
  new URL('./MobileRichMarkdownEditor.web.tsx', import.meta.url),
  'utf8'
)
const presentation = readFileSync(
  new URL('./mobile-rich-markdown-editor-presentation.tsx', import.meta.url),
  'utf8'
)
const controller = readFileSync(
  new URL('./use-mobile-rich-markdown-editor-controller.ts', import.meta.url),
  'utf8'
)
const sessionRoute = readMobileSessionRouteSourceFamily()

describe('mobile rich markdown editor web source', () => {
  it('shares the existing presentation instead of copying the toolbar', () => {
    expect(nativeEditor).toContain('<MobileRichMarkdownEditorPresentation')
    expect(webEditor).toContain('<MobileRichMarkdownEditorPresentation')
    expect(presentation).toContain("{ command: 'paragraph', label: 'Body'")
    expect(presentation).toContain("{ command: 'codeBlock', label: 'Code block'")
    expect(nativeEditor).not.toContain("label: 'Body'")
    expect(webEditor).not.toContain("label: 'Body'")
  })

  it('runs the exact editor document in an isolated data frame', () => {
    expect(webEditor).toContain('buildMobileRichMarkdownEditorHtml({ isolatedFrame: true })')
    expect(webEditor).toContain('data:text/html;charset=utf-8,')
    expect(webEditor).toContain('sandbox="allow-scripts"')
    expect(webEditor).toContain('name={frameToken}')
    expect(webEditor).not.toContain('allow-same-origin')
    expect(webEditor).not.toContain('srcDoc=')
    expect(webEditor).toContain('crypto.getRandomValues(bytes)')
    expect(webEditor).toContain('message.frameToken === frameToken')
    expect(webEditor).not.toContain('event.origin')
    expect(webEditor).not.toContain('event.source !== frame?.contentWindow')
    expect(webEditor).toContain("message.direction === 'editor-to-host'")
    expect(controller).not.toContain('if (readyRef.current) {\n          return')
  })

  it('routes hosted editor links through the existing native capability', () => {
    expect(sessionRoute).toContain('onOpenLink={(url) => {')
    expect(sessionRoute).toContain('sessionDeviceOperations?.openExternalUrl(url)')
    expect(sessionRoute).not.toContain('Linking.openURL')
    expect(controller).toContain('normalizeMobileWebExternalUrl(message.url)')
    expect(controller).not.toContain('mailto:')
    expect(controller).not.toContain('Linking.openURL')
  })
})
