import { describe, expect, it } from 'vitest'
import { RuntimeRpcFailureError } from './types'

describe('RuntimeRpcFailureError compatibility redaction', () => {
  it('removes compatibility evidence from CLI JSON errors', () => {
    const error = new RuntimeRpcFailureError({
      id: 'request-1',
      ok: false,
      error: {
        code: 'compatibility_rejected',
        message: 'Rejected',
        data: {
          orchestrationCompatibilityEvidence: {
            launchToken: 'launch-secret'
          }
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })

    expect(error.data).toEqual({
      orchestrationCompatibilityEvidence: '[redacted]'
    })
    expect(JSON.stringify(error.response)).not.toContain('launch-secret')
  })
})
