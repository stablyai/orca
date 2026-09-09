import { describe, expect, it } from 'vitest'

import { isWhatsAppWebUrl, whatsAppCompatUserAgent } from './browser-whatsapp-ua'

const ELECTRON_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Orca/1.4.198 Chrome/150.0.7871.224 Electron/43.4.1 Safari/537.36'
const STRIPPED_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.224 Safari/537.36'

describe('isWhatsAppWebUrl', () => {
  it('matches the WhatsApp Web host exactly', () => {
    expect(isWhatsAppWebUrl('https://web.whatsapp.com/')).toBe(true)
    expect(isWhatsAppWebUrl('https://WEB.WHATSAPP.COM/qr')).toBe(true)
  })

  it('does not match other WhatsApp surfaces or lookalikes', () => {
    expect(isWhatsAppWebUrl('https://www.whatsapp.com/')).toBe(false)
    expect(isWhatsAppWebUrl('https://faq.whatsapp.com/')).toBe(false)
    expect(isWhatsAppWebUrl('https://web.whatsapp.com.evil.test/')).toBe(false)
    expect(isWhatsAppWebUrl('https://whatsapp.com/')).toBe(false)
    expect(isWhatsAppWebUrl('not a url')).toBe(false)
  })
})

describe('whatsAppCompatUserAgent', () => {
  it('drops only the app and Electron tokens, keeping the Chrome identity byte-identical', () => {
    expect(whatsAppCompatUserAgent(ELECTRON_UA)).toBe(STRIPPED_UA)
  })

  it('handles the lowercase app token dev builds emit', () => {
    expect(
      whatsAppCompatUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) orca/1.0.0 Chrome/134.0.0.0 Electron/30.0.0 Safari/537.36'
      )
    ).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
    )
  })

  it('returns a UA without those tokens unchanged', () => {
    expect(whatsAppCompatUserAgent(STRIPPED_UA)).toBe(STRIPPED_UA)
    const firefoxUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0'
    expect(whatsAppCompatUserAgent(firefoxUa)).toBe(firefoxUa)
  })

  it('is idempotent', () => {
    expect(whatsAppCompatUserAgent(whatsAppCompatUserAgent(ELECTRON_UA))).toBe(STRIPPED_UA)
  })
})
