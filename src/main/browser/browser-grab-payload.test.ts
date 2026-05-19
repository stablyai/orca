import { describe, expect, it } from 'vitest'
import { clampGrabPayload } from './browser-grab-payload'

function makeRawPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
  it('redacts secret-bearing cssClasses outside the attribute path', () => {
    const payload = clampGrabPayload(
      makeRawPayload({
        target: {
          ...(makeRawPayload().target as Record<string, unknown>),
          cssClasses: 'primary access_token=secret'
        }
      })
    )

    expect(payload?.target.cssClasses).toBe('[redacted]')
  })

  it('redacts secret-bearing browser annotation metadata fields', () => {
    const payload = clampGrabPayload(
      makeRawPayload({
        target: {
          ...(makeRawPayload().target as Record<string, unknown>),
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

  it('keeps and clamps browser annotation metadata fields', () => {
    const payload = clampGrabPayload(
      makeRawPayload({
        target: {
          ...(makeRawPayload().target as Record<string, unknown>),
          nearbyElements: Array.from({ length: 10 }, (_, index) => `item-${index}`),
          reactComponents: '<App>'.repeat(200),
          sourceFile: 'src/Button.tsx:12:4'
        }
      })
    )

    expect(payload?.target.nearbyElements).toHaveLength(6)
    expect(payload?.target.reactComponents?.length).toBeLessThanOrEqual(512)
    expect(payload?.target.sourceFile).toBe('src/Button.tsx:12:4')
  })
})
