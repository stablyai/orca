import { describe, expect, it } from 'vitest'
import { RuntimeRpcEnvelopeSchema, isKeepaliveFrame } from './envelope-schema'

describe('RuntimeRpcEnvelopeSchema', () => {
  it('accepts a well-formed success envelope', () => {
    const parsed = RuntimeRpcEnvelopeSchema.safeParse({
      id: 'req-1',
      ok: true,
      result: { anything: 1 },
      _meta: { runtimeId: 'runtime-1' }
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts a well-formed failure envelope', () => {
    const parsed = RuntimeRpcEnvelopeSchema.safeParse({
      id: 'req-1',
      ok: false,
      error: { code: 'not_found', message: 'not_found' },
      _meta: { runtimeId: 'runtime-1' }
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts a failure envelope without _meta', () => {
    // Why: the runtime may fail before it has resolved its own runtimeId, in
    // which case _meta is omitted. The schema must tolerate that rather than
    // rejecting a legitimate failure as an invalid frame.
    const parsed = RuntimeRpcEnvelopeSchema.safeParse({
      id: 'req-1',
      ok: false,
      error: { code: 'runtime_unavailable', message: 'runtime_unavailable' }
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a frame missing the ok discriminator', () => {
    const parsed = RuntimeRpcEnvelopeSchema.safeParse({
      id: 'req-1',
      result: {},
      _meta: { runtimeId: 'runtime-1' }
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects a frame with a non-string id', () => {
    const parsed = RuntimeRpcEnvelopeSchema.safeParse({
      id: 123,
      ok: true,
      result: {},
      _meta: { runtimeId: 'runtime-1' }
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects a frame with unrelated fields only', () => {
    const parsed = RuntimeRpcEnvelopeSchema.safeParse({ hello: 'world' })
    expect(parsed.success).toBe(false)
  })

  it('accepts a keepalive frame', () => {
    const parsed = RuntimeRpcEnvelopeSchema.safeParse({ _keepalive: true })
    expect(parsed.success).toBe(true)
  })

  it('rejects a keepalive frame with _keepalive !== true', () => {
    const parsed = RuntimeRpcEnvelopeSchema.safeParse({ _keepalive: false })
    expect(parsed.success).toBe(false)
  })
})

describe('isKeepaliveFrame', () => {
  it('returns true for a well-formed keepalive', () => {
    expect(isKeepaliveFrame({ _keepalive: true })).toBe(true)
  })

  it('returns false for a success envelope', () => {
    expect(isKeepaliveFrame({ id: 'x', ok: true, result: {}, _meta: { runtimeId: 'r' } })).toBe(
      false
    )
  })

  it('returns false for non-object inputs', () => {
    expect(isKeepaliveFrame(null)).toBe(false)
    expect(isKeepaliveFrame(undefined)).toBe(false)
    expect(isKeepaliveFrame('keepalive')).toBe(false)
  })

  it('returns false when _keepalive is not strictly true', () => {
    expect(isKeepaliveFrame({ _keepalive: 1 })).toBe(false)
    expect(isKeepaliveFrame({ _keepalive: 'true' })).toBe(false)
  })
})
