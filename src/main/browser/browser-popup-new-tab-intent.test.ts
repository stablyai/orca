import { describe, expect, it } from 'vitest'
import {
  isNewBrowserTabPopupIntent,
  normalizeBrowserPopupUrl
} from './browser-popup-new-tab-intent'

describe('isNewBrowserTabPopupIntent', () => {
  it.each([
    // target=_blank, window.open(url), and noopener/noreferrer opens all arrive unnamed as a tab.
    { frameName: '', disposition: 'foreground-tab', tab: true },
    // Cmd/Ctrl-click and middle-click.
    { frameName: '', disposition: 'background-tab', tab: true },
    // Size/position features and Shift-click.
    { frameName: '', disposition: 'new-window', tab: false },
    // A named open may use the returned handle, as OAuth does.
    { frameName: 'oauth', disposition: 'foreground-tab', tab: false },
    { frameName: 'oauth', disposition: 'new-window', tab: false },
    { frameName: '', disposition: 'other', tab: false }
  ])('$frameName/$disposition → tab: $tab', ({ frameName, disposition, tab }) => {
    expect(
      isNewBrowserTabPopupIntent({ url: 'https://example.com/docs', frameName, disposition })
    ).toBe(tab)
  })

  it.each(['foreground-tab', 'background-tab'])(
    'keeps Deel Google sign-in as a popup: %s',
    (disposition) => {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      url.search = new URLSearchParams({
        scope: 'email profile openid',
        response_type: 'token',
        redirect_uri: 'https://api.deel.com/login/google',
        response_mode: 'form_post',
        prompt: 'select_account',
        client_id: 'test-client',
        state: 'https://app.deel.com'
      }).toString()
      expect(isNewBrowserTabPopupIntent({ url: url.href, frameName: '', disposition })).toBe(false)
    }
  )

  it('preserves POST requests even when the form has no fields', () => {
    for (const data of [[], [{ type: 'rawData' as const, bytes: Buffer.from('code=synthetic') }]]) {
      expect(
        isNewBrowserTabPopupIntent({
          url: 'https://example.com/login',
          frameName: '',
          disposition: 'foreground-tab',
          postBody: { contentType: 'application/x-www-form-urlencoded', data }
        })
      ).toBe(false)
    }
  })

  it.each(['about:blank', 'about:blank#state'])('preserves a blank popup handle: %s', (url) => {
    expect(normalizeBrowserPopupUrl(url)).toBe(url)
    expect(isNewBrowserTabPopupIntent({ url, frameName: '', disposition: 'foreground-tab' })).toBe(
      false
    )
  })

  it.each([
    'about:blank?state=x',
    'about:srcdoc',
    'about:blank/other',
    'file:///tmp/login',
    'javascript:alert(1)',
    'data:text/html,login',
    '',
    undefined
  ])('rejects unsafe popup destinations: %s', (url) => {
    expect(normalizeBrowserPopupUrl(url)).toBeNull()
  })

  it.each([
    'code',
    'token',
    'id_token',
    'none',
    'code token',
    'id_token code',
    'token id_token',
    'token code id_token'
  ])('preserves provider-independent OAuth and OpenID Connect requests: %s', (responseType) => {
    const url = new URL('https://sso.example.com/authorize')
    url.search = new URLSearchParams({
      client_id: 'client',
      redirect_uri: 'http://localhost:3000/callback',
      response_type: responseType
    }).toString()
    expect(
      isNewBrowserTabPopupIntent({ url: url.href, frameName: '', disposition: 'foreground-tab' })
    ).toBe(false)
  })

  it.each([
    'https://example.com/docs',
    'https://example.com/?client_id=a',
    'https://example.com/?client_id=a&redirect_uri=b',
    'https://example.com/?client_id=&redirect_uri=b&response_type=code',
    'https://example.com/?client_id=a&redirect_uri=%20&response_type=code',
    'https://example.com/?client_id=a&redirect_uri=b&response_type=',
    'https://example.com/?client_id=a&redirect_uri=b&response_type=json',
    'https://example.com/?client_id=a&redirect_uri=b&response_type=code+code',
    'https://example.com/?client_id=a&redirect_uri=b&response_type=none+token',
    'https://example.com/?client_id=a&redirect_uri=b&response_type=code+unknown',
    'file:///authorize?client_id=a&redirect_uri=b&response_type=code',
    'not a url'
  ])('keeps non-authorization URLs on the existing tab path: %s', (url) => {
    expect(isNewBrowserTabPopupIntent({ url, frameName: '', disposition: 'foreground-tab' })).toBe(
      true
    )
  })
})
