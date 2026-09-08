import { describe, expect, it } from 'vitest'
import { MobileWebBridgeClientError } from '../../../src/mobile-web/src/mobile-web-bridge-client-error'
import { hostedSourceControlResponse } from './web-host-source-control-response'

describe('hosted source control errors', () => {
  it.each(['conflict', 'unsupported_capability'] as const)(
    'preserves the page %s error for the screen',
    async (code) => {
      const error = new MobileWebBridgeClientError(code, false)
      error.message = 'The review changed. Refresh the review.'
      await expect(
        hostedSourceControlResponse(async () => {
          throw error
        })
      ).resolves.toMatchObject({
        ok: false,
        error: { code, message: error.message }
      })
    }
  )

  it('keeps unclassified failures generic', async () => {
    await expect(
      hostedSourceControlResponse(async () => {
        throw new Error('private details')
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'host_error', message: 'Source control action failed' }
    })
  })
})
