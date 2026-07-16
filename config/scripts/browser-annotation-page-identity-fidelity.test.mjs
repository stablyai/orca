import { describe, expect, it } from 'vitest'
import { clampGrabPayload } from '../../src/main/browser/browser-grab-payload'
import { browserAnnotationDocumentKey } from '../../src/renderer/src/components/browser-pane/browser-annotation-page-identity'

function annotation(url) {
  return {
    id: 'sample',
    browserPageId: 'page-1',
    comment: 'comment',
    intent: 'change',
    priority: 'important',
    createdAt: '2026-01-01T00:00:00.000Z',
    payload: {
      page: {
        sanitizedUrl: url,
        title: 'Page',
        viewportWidth: 1280,
        viewportHeight: 720,
        scrollX: 0,
        scrollY: 0,
        devicePixelRatio: 1,
        capturedAt: '2026-01-01T00:00:00.000Z'
      },
      target: {
        tagName: 'button',
        selector: '#button',
        textSnippet: 'sample',
        htmlSnippet: '<button />',
        attributes: {},
        accessibility: {
          role: 'button',
          accessibleName: 'sample',
          ariaLabel: null,
          ariaLabelledBy: null
        },
        rectViewport: { x: 1, y: 2, width: 3, height: 4 },
        rectPage: { x: 5, y: 6, width: 7, height: 8 },
        computedStyles: {
          display: 'block',
          position: 'static',
          width: '3px',
          height: '4px',
          margin: '0',
          padding: '0',
          color: 'black',
          backgroundColor: 'white',
          border: '0',
          borderRadius: '0',
          fontFamily: 'sans-serif',
          fontSize: '16px',
          fontWeight: '400',
          lineHeight: 'normal',
          textAlign: 'left',
          zIndex: 'auto'
        }
      },
      nearbyText: [],
      ancestorPath: [],
      screenshot: null
    }
  }
}

function clampedDocumentKey(rawUrl) {
  const sample = annotation('https://example.com/base')
  return (
    clampGrabPayload({
      ...sample.payload,
      page: { ...sample.payload.page, sanitizedUrl: rawUrl }
    })?.page.sanitizedUrl || null
  )
}

describe('browser annotation document identity fidelity', () => {
  it('matches the main clamp across supported and rejected URLs', () => {
    const cases = [
      'https://example.com/docs?token=redacted#section',
      'https://example.com/docs#section',
      'file:///C:/Repos/orca/README.md?token=redacted#section',
      'about:blank',
      'data:text/html,',
      'blob:https://example.com/123',
      'not a url'
    ]

    for (const rawUrl of cases) {
      expect(browserAnnotationDocumentKey(annotation(rawUrl))).toBe(clampedDocumentKey(rawUrl))
    }
  })
})
