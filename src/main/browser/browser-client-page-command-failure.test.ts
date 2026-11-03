import { describe, expect, it } from 'vitest'
import {
  browserClientPageCommandFailure,
  BrowserClientPageCommandError
} from './browser-client-page-command-failure'

describe('browserClientPageCommandFailure', () => {
  const signal = new AbortController().signal

  it('carries a URL mismatch back to the authority', () => {
    const mismatch = {
      expectedUrl: 'https://example.com/a',
      actualUrl: 'https://example.com/b',
      browserPageId: 'page-1',
      mayHaveStarted: false
    }

    expect(
      browserClientPageCommandFailure(
        new BrowserClientPageCommandError('browser_expected_url_mismatch', {
          expectedUrlMismatch: mismatch
        }),
        signal
      )
    ).toEqual({
      status: 'failed',
      errorCode: 'browser_expected_url_mismatch',
      expectedUrlMismatch: mismatch
    })
  })
})
