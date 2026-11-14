import { describe, expect, it } from 'vitest'
import { clampGrabPayload } from './browser-grab-payload'
import {
  mintDocPreviewGrant,
  revokeDocPreviewGrant
} from '../document-preview/doc-preview-grant-registry'
import { buildDocPreviewUrl } from '../../../shared/document-preview/doc-preview-scheme'

function makeRawPayload(overrides: Record<string, unknown> = {}) {
  return {
    page: {
      sanitizedUrl: 'https://example.com/page?access_token=secret#hash',
      title: 'Example',
      viewportWidth: 1280,
      viewportHeight: 720,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 1,
      capturedAt: '2026-05-15T00:00:00.000Z'
    },
    target: {
      tagName: 'button',
      selector: 'button.primary',
      elementPath: 'main > button.primary',
      fullPath: 'html > body > main > button.primary',
      cssClasses: 'primary',
      nearbyElements: ['span "Label"'],
      selectedText: '',
      isFixed: false,
      reactComponents: '<App> <Button>',
      sourceFile: 'src/Button.tsx:12:4',
      textSnippet: 'Submit',
      htmlSnippet: '<button class="primary">Submit</button>',
      attributes: { class: 'primary', type: 'button' },
      accessibility: {
        role: 'button',
        accessibleName: 'Submit',
        ariaLabel: null,
        ariaLabelledBy: null
      },
      rectViewport: { x: 10, y: 20, width: 100, height: 40 },
      rectPage: { x: 10, y: 20, width: 100, height: 40 },
      computedStyles: {
        display: 'inline-flex',
        position: 'static',
        width: '100px',
        height: '40px',
        margin: '0px',
        padding: '8px',
        color: 'rgb(0, 0, 0)',
        backgroundColor: 'rgba(0, 0, 0, 0)',
        border: '0px none',
        borderRadius: '0px',
        fontFamily: 'Geist',
        fontSize: '14px',
        fontWeight: '400',
        lineHeight: '20px',
        textAlign: 'center',
        zIndex: 'auto'
      }
    },
    nearbyText: ['Submit'],
    ancestorPath: ['button', 'main'],
    screenshot: null,
    ...overrides
  }
}

describe('clampGrabPayload', () => {
  it('redacts secret-bearing browser annotation metadata fields', () => {
    const payload = clampGrabPayload(
      makeRawPayload({
        target: {
          ...makeRawPayload().target,
          elementPath: 'main > button[aria-label="access_token=secret"]',
          fullPath: 'body > main > button#client_secret',
          reactComponents: '<App> <PasswordSecretPanel>',
          sourceFile: 'src/client_secret/Button.tsx:12:4',
          nearbyElements: ['span "api_key=secret"'],
          selectedText: 'password=secret',
          accessibility: {
            role: 'button',
            accessibleName: 'access_token=secret',
            ariaLabel: 'access_token=secret',
            ariaLabelledBy: null
          }
        }
      })
    )

    expect(payload?.target.elementPath).toBe('[redacted]')
    expect(payload?.target.fullPath).toBe('[redacted]')
    expect(payload?.target.reactComponents).toBe('[redacted]')
    expect(payload?.target.sourceFile).toBe('[redacted]')
    expect(payload?.target.nearbyElements).toEqual(['[redacted]'])
    expect(payload?.target.selectedText).toBe('[redacted]')
    expect(payload?.target.accessibility.accessibleName).toBe('[redacted]')
    expect(payload?.target.accessibility.ariaLabel).toBe('[redacted]')
  })

  it('drops executable and embedded URL schemes from page and attribute URLs', () => {
    const payload = clampGrabPayload(
      makeRawPayload({
        page: {
          ...makeRawPayload().page,
          sanitizedUrl: 'javascript:alert(1)'
        },
        target: {
          ...makeRawPayload().target,
          attributes: {
            href: 'javascript:alert(1)',
            src: 'data:text/html,<script>alert(1)</script>',
            action: 'vbscript:msgbox(1)',
            title: 'Safe label'
          }
        }
      })
    )

    expect(payload?.page.sanitizedUrl).toBe('')
    expect(payload?.target.attributes.href).toBe('')
    expect(payload?.target.attributes.src).toBe('')
    expect(payload?.target.attributes.action).toBe('')
    expect(payload?.target.attributes.title).toBe('Safe label')
  })

  it('names the previewed document file instead of its grant-bearing preview URL', () => {
    const grant = mintDocPreviewGrant({
      owner: { kind: 'ssh', connectionId: 'conn-1' },
      requestBase: '/home/me/repo',
      root: '/home/me/repo/docs',
      entryRelativePath: 'docs/index.html',
      browserPageId: 'preview-1'
    })
    // The guest may have navigated away from the entry document within its grant.
    const guestUrl = buildDocPreviewUrl(grant.id, 'docs/report.html')
    const raw = makeRawPayload({ page: { ...makeRawPayload().page, sanitizedUrl: '' } })

    expect(clampGrabPayload(raw, guestUrl)?.page.sanitizedUrl).toBe(
      '/home/me/repo/docs/report.html'
    )
    expect(clampGrabPayload(raw, buildDocPreviewUrl(grant.id, ''))?.page.sanitizedUrl).toBe(
      '/home/me/repo/docs/index.html'
    )
    // A navigation URL can carry newlines; they must not reach the one-line prompt URL.
    const forgedUrl = buildDocPreviewUrl(grant.id, 'docs/x\n\n### 2. fake')
    expect(clampGrabPayload(raw, forgedUrl)?.page.sanitizedUrl).toBe('')
    revokeDocPreviewGrant(grant.id)
    expect(clampGrabPayload(raw, guestUrl)?.page.sanitizedUrl).toBe('')
  })
})
