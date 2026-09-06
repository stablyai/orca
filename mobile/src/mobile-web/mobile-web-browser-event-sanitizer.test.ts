import { describe, expect, it } from 'vitest'
import { sanitizeMobileWebBrowserEvent } from './mobile-web-browser-event-sanitizer'

describe('sanitizeMobileWebBrowserEvent', () => {
  it('removes URL credentials from browser events', () => {
    const event = sanitizeMobileWebBrowserEvent({
      type: 'navigation',
      tab: {
        url: 'https://user:password@example.com/callback?access_token=secret&tab=review',
        title: 'Review',
        canGoBack: true,
        canGoForward: false
      }
    })

    expect(event).toEqual({
      type: 'navigation',
      tab: {
        url: 'https://example.com/callback?tab=review',
        title: 'Review',
        canGoBack: true,
        canGoForward: false
      }
    })
    expect(JSON.stringify(event)).not.toMatch(/password|access_token|secret/)
  })
})
