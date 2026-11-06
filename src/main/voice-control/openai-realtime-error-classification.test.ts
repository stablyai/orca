import { describe, expect, it } from 'vitest'
import {
  classifyOpenAiFetchError,
  classifyOpenAiHttpStatus
} from './openai-realtime-error-classification'

describe('classifyOpenAiFetchError', () => {
  it('classifies a Zscaler-style MITM cert chain as tls-intercept', () => {
    const cause = Object.assign(new Error('self-signed certificate in certificate chain'), {
      code: 'SELF_SIGNED_CERT_IN_CHAIN'
    })
    const error = Object.assign(new TypeError('fetch failed'), { cause })
    expect(classifyOpenAiFetchError(error)).toBe('tls-intercept')
  })

  it('finds cert codes nested under an undici cause chain', () => {
    const leaf = Object.assign(new Error('unable to verify'), {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
    })
    const mid = Object.assign(new Error('secure connect'), { code: 'UND_ERR_SOCKET', cause: leaf })
    const top = Object.assign(new TypeError('fetch failed'), { cause: mid })
    expect(classifyOpenAiFetchError(top)).toBe('tls-intercept')
  })

  it('classifies DNS and reset failures as network', () => {
    const cause = Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' })
    expect(classifyOpenAiFetchError(Object.assign(new TypeError('fetch failed'), { cause }))).toBe(
      'network'
    )
  })

  it('prefers tls-intercept over network when both appear in the chain', () => {
    const leaf = Object.assign(new Error('cert'), { code: 'ERR_CERT_AUTHORITY_INVALID' })
    const top = Object.assign(new Error('socket'), { code: 'UND_ERR_SOCKET', cause: leaf })
    expect(classifyOpenAiFetchError(top)).toBe('tls-intercept')
  })

  it('returns unknown for non-Error input and unclassified errors', () => {
    expect(classifyOpenAiFetchError('boom')).toBe('unknown')
    expect(classifyOpenAiFetchError(new Error('parse error'))).toBe('unknown')
  })

  it('stops walking deep cause chains', () => {
    let err: Error = Object.assign(new Error('leaf'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' })
    for (let i = 0; i < 10; i += 1) {
      err = Object.assign(new Error('wrap'), { cause: err })
    }
    expect(classifyOpenAiFetchError(err)).toBe('unknown')
  })
})

describe('classifyOpenAiHttpStatus', () => {
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'quota'],
    [500, 'unavailable'],
    [503, 'unavailable'],
    [400, 'unknown']
  ] as const)('maps %i to %s', (status, kind) => {
    expect(classifyOpenAiHttpStatus(status)).toBe(kind)
  })
})
