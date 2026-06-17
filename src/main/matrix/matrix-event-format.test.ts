import { describe, expect, it } from 'vitest'
import {
  classifyMatrixError,
  formatHandlePrefix,
  parseInboundHandle,
  stripReplyFallback
} from './matrix-event-format'

describe('classifyMatrixError', () => {
  it('classifies auth errors by errcode', () => {
    const result = classifyMatrixError({ errcode: 'M_UNKNOWN_TOKEN', message: 'bad token' })
    expect(result).toEqual({ type: 'auth', message: 'bad token' })
  })

  it('classifies forbidden errors by errcode', () => {
    expect(classifyMatrixError({ errcode: 'M_FORBIDDEN', message: 'nope' }).type).toBe('forbidden')
  })

  it('classifies rate-limit errors by errcode', () => {
    expect(classifyMatrixError({ errcode: 'M_LIMIT_EXCEEDED', message: 'slow' }).type).toBe(
      'rate_limit'
    )
  })

  it('falls back to HTTP status when no errcode is present', () => {
    expect(classifyMatrixError({ httpStatus: 401, message: 'unauth' }).type).toBe('auth')
    expect(classifyMatrixError({ status: 403, message: 'forbidden' }).type).toBe('forbidden')
    expect(classifyMatrixError({ httpStatus: 429, message: 'rate' }).type).toBe('rate_limit')
  })

  it('classifies aborts and connection failures as network', () => {
    const abort = new Error('The operation was aborted')
    abort.name = 'AbortError'
    expect(classifyMatrixError(abort).type).toBe('network')
    expect(classifyMatrixError(new Error('connect ECONNREFUSED')).type).toBe('network')
    expect(classifyMatrixError(new Error('getaddrinfo ENOTFOUND host')).type).toBe('network')
    expect(classifyMatrixError(new Error('fetch failed')).type).toBe('network')
  })

  it('falls back to unknown for unrecognized errors', () => {
    const result = classifyMatrixError(new Error('something odd'))
    expect(result).toEqual({ type: 'unknown', message: 'something odd' })
  })

  it('stringifies non-Error values', () => {
    expect(classifyMatrixError('plain string').message).toBe('plain string')
  })
})

describe('formatHandlePrefix', () => {
  it('prefixes the body with the orca handle marker', () => {
    expect(formatHandlePrefix('feat-x', 'hello world')).toBe('[orca feat-x] hello world')
  })
})

describe('parseInboundHandle', () => {
  it('extracts a leading @handle token and the remaining body', () => {
    expect(parseInboundHandle('@feat-x do the thing')).toEqual({
      handle: 'feat-x',
      rest: 'do the thing'
    })
  })

  it('supports underscores and digits in the handle', () => {
    expect(parseInboundHandle('@agent_2 ping')).toEqual({ handle: 'agent_2', rest: 'ping' })
  })

  it('returns no handle when there is no leading @token', () => {
    expect(parseInboundHandle('just a message')).toEqual({
      handle: null,
      rest: 'just a message'
    })
  })

  it('returns no handle when the @ is not followed by whitespace + body', () => {
    expect(parseInboundHandle('@feat-x')).toEqual({ handle: null, rest: '@feat-x' })
  })

  it('does not treat punctuation-heavy mentions as a handle', () => {
    expect(parseInboundHandle('@user:server.tld hi').handle).toBeNull()
  })

  it('preserves multiline rest content', () => {
    expect(parseInboundHandle('@h line1\nline2')).toEqual({ handle: 'h', rest: 'line1\nline2' })
  })
})

describe('stripReplyFallback', () => {
  it('strips a single-line quote fallback and its blank separator', () => {
    const body = '> <@user:hs> original message\n\nyes, proceed'
    expect(stripReplyFallback(body)).toBe('yes, proceed')
  })

  it('strips a multi-line quote block', () => {
    const body = '> <@user:hs> line one\n> line two\n> line three\n\nthe actual reply'
    expect(stripReplyFallback(body)).toBe('the actual reply')
  })

  it('returns the body unchanged when there is no leading quote block', () => {
    expect(stripReplyFallback('just a normal reply')).toBe('just a normal reply')
  })

  it('does not strip a quote that appears later in the body', () => {
    const body = 'run this\n> not a fallback quote\nand that'
    expect(stripReplyFallback(body)).toBe(body)
  })

  it('preserves the multiline reply that follows the quote block', () => {
    const body = '> <@user:hs> q\n\nline1\nline2'
    expect(stripReplyFallback(body)).toBe('line1\nline2')
  })

  it('handles a quote block with no following reply', () => {
    expect(stripReplyFallback('> <@user:hs> just a quote')).toBe('')
  })
})
