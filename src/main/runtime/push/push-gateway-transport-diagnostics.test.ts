import { describe, expect, it } from 'vitest'
import { postPushGatewayJson } from './push-gateway-response'
import { describePushGatewayTransportFailure } from './push-gateway-transport-diagnostics'

describe('push gateway transport diagnostics', () => {
  it('allows only stable code labels from nested connection failures', async () => {
    const privateEndpoint = 'https://private.example.invalid/?token=sensitive'
    const refused = Object.assign(new Error(privateEndpoint), {
      code: 'ENETUNREACH',
      address: '10.11.12.13',
      port: 443
    })
    const timeout = Object.assign(new Error(privateEndpoint), { code: 'ETIMEDOUT' })
    const fakeCode = Object.assign(new Error(privateEndpoint), { code: privateEndpoint })
    Object.defineProperty(fakeCode, 'cause', {
      get: () => {
        throw new Error('Diagnostic reads must not invoke getters')
      }
    })
    const error = new TypeError(privateEndpoint, {
      cause: new AggregateError([timeout, fakeCode, refused, timeout], privateEndpoint)
    })
    let diagnostic: string | undefined
    const result = await postPushGatewayJson(
      async () => {
        throw error
      },
      privateEndpoint,
      {},
      (description) => {
        diagnostic = description
      }
    )
    expect(diagnostic).toBe('ENETUNREACH, ETIMEDOUT')
    expect(result).toEqual({ ok: false, reason: 'unreachable' })
  })

  it('does not confuse the overall request deadline with a connection timeout', () => {
    const deadline = new DOMException('private request information', 'TimeoutError')
    const signal = AbortSignal.abort(deadline)
    const connectTimeout = new TypeError('private request information', {
      cause: { code: 'UND_ERR_CONNECT_TIMEOUT' }
    })
    expect(describePushGatewayTransportFailure(deadline, signal)).toBe('request_deadline')
    expect(describePushGatewayTransportFailure(connectTimeout, signal)).toBe(
      'UND_ERR_CONNECT_TIMEOUT'
    )
    expect(describePushGatewayTransportFailure(deadline)).toBe('unknown_network_error')
  })
})
