import { describe, expect, it } from 'vitest'
import {
  normalizeAutomationWebhookConfig,
  composeAutomationDispatchPrompt
} from '../../shared/automation-webhook'
import { verifyWebhookSecret } from './webhook-secret'

describe('untrusted webhook configuration and payloads', () => {
  it.each(['token', 'hmac_sha256'] as const)(
    'keeps %s verification fail-closed for blank secrets',
    (secretMode) => {
      for (const secret of ['', '   ', null]) {
        const config = normalizeAutomationWebhookConfig({ enabled: true, secretMode, secret })
        expect(config).toEqual({ enabled: true, secretMode, secret: null })
        if (!config) {
          throw new Error('webhook configuration was unexpectedly removed')
        }
        expect(verifyWebhookSecret({ config, headers: {}, rawBody: 'payload' })).toEqual({
          ok: false,
          reason: 'no_secret_configured'
        })
      }
    }
  )

  it('strips terminal controls while keeping payload newline, tab and Unicode', () => {
    const controls = Array.from({ length: 160 }, (_, n) => n)
      .filter((n) => (n < 32 && n !== 9 && n !== 10) || (n >= 127 && n <= 159))
      .map((n) => String.fromCharCode(n))
      .join('')
    const output = composeAutomationDispatchPrompt(
      { prompt: 'Review' },
      {
        id: 'safe-run',
        webhookDelivery: {
          body: `hello${controls}\n\t世界`,
          contentType: null,
          truncated: false,
          receivedAt: 1
        }
      }
    )
    expect(output).toBe(
      'Review\n\n<webhook-payload-safe-run>\nhello\n\t世界\n</webhook-payload-safe-run>'
    )
  })
})
