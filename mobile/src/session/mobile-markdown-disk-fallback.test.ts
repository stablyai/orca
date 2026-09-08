import { describe, expect, it } from 'vitest'
import type { RpcFailure } from '../transport/types'
import { shouldReadMarkdownFromDiskAfterReadTabFailure } from './mobile-markdown-disk-fallback'

function failure(code: string, message: string): RpcFailure {
  return {
    id: 'request-1',
    ok: false,
    error: { code, message },
    _meta: { runtimeId: 'runtime-1' }
  }
}

describe('shouldReadMarkdownFromDiskAfterReadTabFailure', () => {
  it('allows disk reads for current renderer unavailable runtime errors', () => {
    expect(
      shouldReadMarkdownFromDiskAfterReadTabFailure(
        failure('runtime_error', 'renderer_unavailable')
      )
    ).toBe(true)
  })

  it('allows disk reads if renderer unavailable becomes a passthrough code', () => {
    expect(
      shouldReadMarkdownFromDiskAfterReadTabFailure(
        failure('renderer_unavailable', 'renderer_unavailable')
      )
    ).toBe(true)
  })

  it('does not hide unrelated markdown read failures behind a disk read', () => {
    expect(
      shouldReadMarkdownFromDiskAfterReadTabFailure(failure('runtime_error', 'tab_not_found'))
    ).toBe(false)
    expect(
      shouldReadMarkdownFromDiskAfterReadTabFailure(failure('invalid_argument', 'bad tab'))
    ).toBe(false)
  })
})
