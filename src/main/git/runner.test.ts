// Why: covers two recent classifier fixes — Retry-After honoring on 429
// (transient detection must propagate, not silently retry on 250ms cadence)
// and stderr extraction from execFile rejections (err.message is unreliable).
import { describe, expect, it } from 'vitest'
import { extractExecError, isTransientGhError, parseRetryAfterMs } from './runner'

describe('parseRetryAfterMs', () => {
  it('returns null when no Retry-After is present', () => {
    expect(parseRetryAfterMs('HTTP 429 Too Many Requests')).toBeNull()
  })

  it('parses integer seconds', () => {
    expect(parseRetryAfterMs('HTTP 429\nRetry-After: 30\n')).toBe(30_000)
  })

  it('handles case-insensitive header name and surrounding whitespace', () => {
    expect(parseRetryAfterMs('  retry-after:   12  \n')).toBe(12_000)
  })

  it('returns null for malformed values', () => {
    expect(parseRetryAfterMs('Retry-After: not-a-date')).toBeNull()
  })
})

describe('isTransientGhError', () => {
  it('retries 5xx errors', () => {
    expect(isTransientGhError('HTTP 502 Bad Gateway')).toBe(true)
    expect(isTransientGhError('http 503')).toBe(true)
  })

  it('retries network resets', () => {
    expect(isTransientGhError('connect ECONNRESET 10.0.0.1:443')).toBe(true)
    expect(isTransientGhError('socket hang up')).toBe(true)
  })

  it('retries 429 without Retry-After', () => {
    expect(isTransientGhError('HTTP 429 Too Many Requests')).toBe(true)
  })

  it('does NOT retry 429 with Retry-After', () => {
    // Why: when GitHub returns Retry-After, the server is telling us how long
    // to wait. Retrying on our 250ms cadence just earns another 429 and burns
    // the retry budget.
    expect(
      isTransientGhError('HTTP 429 Too Many Requests\nRetry-After: 60\n')
    ).toBe(false)
  })

  it('does NOT retry 4xx that aren\'t 429', () => {
    expect(isTransientGhError('HTTP 401 Unauthorized')).toBe(false)
    expect(isTransientGhError('HTTP 404 Not Found')).toBe(false)
    expect(isTransientGhError('HTTP 422 Unprocessable Entity')).toBe(false)
  })
})

describe('extractExecError', () => {
  it('reads stderr and stdout from explicit fields', () => {
    const err = Object.assign(new Error('Command failed'), {
      stderr: 'real stderr content',
      stdout: '{"data": null}'
    })
    expect(extractExecError(err)).toEqual({
      stderr: 'real stderr content',
      stdout: '{"data": null}'
    })
  })

  it('decodes Buffer stderr/stdout', () => {
    const err = Object.assign(new Error('Command failed'), {
      stderr: Buffer.from('buf-stderr', 'utf-8'),
      stdout: Buffer.from('buf-stdout', 'utf-8')
    })
    expect(extractExecError(err)).toEqual({
      stderr: 'buf-stderr',
      stdout: 'buf-stdout'
    })
  })

  it('falls back to err.message when stderr/stdout are absent', () => {
    const err = new Error('Some message')
    expect(extractExecError(err)).toEqual({
      stderr: 'Some message',
      stdout: ''
    })
  })

  it('handles non-Error rejections', () => {
    expect(extractExecError('plain string error')).toEqual({
      stderr: 'plain string error',
      stdout: ''
    })
  })
})
