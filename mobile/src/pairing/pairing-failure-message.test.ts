import { expect, it } from 'vitest'
import { getPairingFailureMessage } from './pairing-failure-message'

it('uses a safe fallback instead of exposing a protected handshake error', () => {
  expect(
    getPairingFailureMessage({
      screen: 'confirm',
      error: new Error('CF-Access-Client-Secret: synthetic-secret'),
      timedOut: false,
      timeoutMs: 25_000,
      fallbackMessage: 'The protected connection failed.',
      t: (_key, fallback, params) => fallback.replace('{{error}}', String(params?.error))
    })
  ).toBe('The protected connection failed.')
})
