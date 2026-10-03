import { describe, expect, it, vi } from 'vitest'
import { setActiveSink } from '../../observability/tracer'
import { mapDispatcherError } from './dispatcher-error-response'

const meta = { runtimeId: 'fixture-runtime' }

describe('runtime access error disclosure', () => {
  it.each(['runtimeAccess.list', 'runtimeAccess.revoke'])(
    'redacts unexpected errors from %s',
    (method) => {
      for (const error of [
        new Error('EACCES: cannot write /fixture/private/device-registry.json'),
        'private storage detail',
        Object.assign(new Error('private storage detail'), {
          code: 'EACCES',
          data: { privatePath: '/fixture/private/device-registry.json' },
          cause: new Error('private nested detail')
        })
      ]) {
        expect(
          mapDispatcherError({ id: 'req', method, authToken: 'fixture' }, meta, error)
        ).toEqual({
          id: 'req',
          ok: false,
          error: {
            code: 'runtime_error',
            message: 'Unexpected runtime error.'
          },
          _meta: meta
        })
      }
    }
  )

  it.each(['forbidden', 'runtime_access_not_found', 'runtime_access_unavailable'])(
    'preserves the intentional %s response',
    (code) => {
      const error = Object.assign(new Error('Public recovery guidance'), { code })
      expect(
        mapDispatcherError(
          { id: 'req', method: 'runtimeAccess.revoke', authToken: 'fixture' },
          meta,
          error
        )
      ).toMatchObject({ ok: false, error: { code, message: 'Public recovery guidance' } })
    }
  )

  it('keeps existing RPC error contracts outside the new administrative surface', () => {
    const error = new Error('binary_file')
    expect(
      mapDispatcherError({ id: 'req', method: 'files.read', authToken: 'fixture' }, meta, error)
    ).toMatchObject({ ok: false, error: { code: 'runtime_error', message: 'binary_file' } })
  })

  it('records unexpected details through the existing local diagnostic sink', () => {
    const push = vi.fn()
    setActiveSink({ push, flush: vi.fn(), close: vi.fn() })
    try {
      mapDispatcherError(
        { id: 'req', method: 'runtimeAccess.revoke', authToken: 'fixture' },
        meta,
        new Error('fixture disk full')
      )
      expect(push).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          name: 'rpc.runtime-access.unexpected-error',
          exit: expect.objectContaining({
            _tag: 'Failure',
            cause: expect.stringContaining('fixture disk full')
          })
        })
      )
    } finally {
      setActiveSink(null)
    }
  })
})
