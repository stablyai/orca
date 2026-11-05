import { describe, expect, it } from 'vitest'
import {
  browserScreencastSubscriptionPageId,
  mintBrowserScreencastSubscriptionId
} from './browser-screencast-subscription-id'

describe('browser screencast subscription ids', () => {
  it('names the page they were minted for', () => {
    const id = mintBrowserScreencastSubscriptionId('8e7f013e-page', 'nonce-1')
    expect(id).toBe('browser-screencast:8e7f013e-page:nonce-1')
    expect(browserScreencastSubscriptionPageId(id)).toBe('8e7f013e-page')
  })

  it.each(['browser-screencast:', 'browser-screencast::n', 'terminal:page:n', 'page'])(
    'reads no page from %s',
    (id) => {
      expect(browserScreencastSubscriptionPageId(id)).toBeNull()
    }
  )
})
