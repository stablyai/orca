import '../../shared/remote-runtime/host-store/environment-store-worker-test-fixture'
import { describe, expect, it } from 'vitest'
import { RuntimeRpcEnvelopeSchema } from './envelope-schema'

describe('RuntimeRpcEnvelopeSchema', () => {
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
})
