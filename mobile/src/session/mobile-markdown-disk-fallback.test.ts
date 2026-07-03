import { describe, expect, it } from 'vitest'
import type { RpcFailure } from '../transport/types'
import {
  buildMarkdownDiskFallbackDoc,
  shouldReadMarkdownFromDiskAfterReadTabFailure
} from './mobile-markdown-disk-fallback'

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

describe('buildMarkdownDiskFallbackDoc', () => {
  it('builds a read-only markdown document from disk content', () => {
    expect(
      buildMarkdownDiskFallbackDoc({
        content: '# Notes',
        truncated: false,
        tabIsDirty: false
      })
    ).toEqual({
      status: 'ready',
      content: '# Notes',
      localContent: '# Notes',
      baseVersion: '',
      isDirty: false,
      editable: false,
      stale: false,
      readOnlyReason: 'Editing needs Orca desktop running.'
    })
  })

  it('marks disk content stale when the desktop tab has unsaved changes', () => {
    expect(
      buildMarkdownDiskFallbackDoc({
        content: '# Notes',
        truncated: false,
        tabIsDirty: true
      })
    ).toMatchObject({
      editable: false,
      stale: true,
      readOnlyReason: 'Desktop has unsaved changes. Showing disk content.'
    })
  })

  it('warns when the disk read is truncated', () => {
    expect(
      buildMarkdownDiskFallbackDoc({
        content: '# Partial',
        truncated: true,
        tabIsDirty: true
      })
    ).toMatchObject({
      editable: false,
      stale: true,
      readOnlyReason: 'File too large for mobile preview'
    })
  })
})
