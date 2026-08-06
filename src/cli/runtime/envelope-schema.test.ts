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

  it('accepts and strips additive future success fields', () => {
    const parsed = RuntimeRpcEnvelopeSchema.safeParse({
      id: 'req-1',
      ok: true,
      result: { value: 1, futureResultField: true },
      futureEnvelopeField: 'new',
      _meta: { runtimeId: 'runtime-1', futureMetaField: 2 }
    })

    expect(parsed).toEqual({
      success: true,
      data: {
        id: 'req-1',
        ok: true,
        result: { value: 1, futureResultField: true },
        _meta: { runtimeId: 'runtime-1' }
      }
    })
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

  it('accepts structured failure data for agent recovery hints', () => {
    const parsed = RuntimeRpcEnvelopeSchema.safeParse({
      id: 'req-1',
      ok: false,
      error: {
        code: 'app_not_found',
        message: 'app not found: Gmail',
        data: {
          nextSteps: ['Target the desktop browser app/window that contains Gmail.']
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })

    expect(parsed.success).toBe(true)
  })

  it('accepts and strips additive future failure fields', () => {
    const parsed = RuntimeRpcEnvelopeSchema.safeParse({
      id: 'req-1',
      ok: false,
      futureEnvelopeField: 'new',
      error: {
        code: 'failed',
        message: 'Nope',
        data: { retryable: true },
        futureErrorField: 2
      },
      _meta: { runtimeId: 'runtime-1', futureMetaField: 3 }
    })

    expect(parsed).toEqual({
      success: true,
      data: {
        id: 'req-1',
        ok: false,
        error: { code: 'failed', message: 'Nope', data: { retryable: true } },
        _meta: { runtimeId: 'runtime-1' }
      }
    })
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

  it('still rejects malformed known fields when future fields are present', () => {
    const parsed = RuntimeRpcEnvelopeSchema.safeParse({
      id: 'req-1',
      ok: false,
      error: { code: 500, message: 'Nope', futureErrorField: true },
      futureEnvelopeField: 'new'
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
