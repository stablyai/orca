import { describe, expect, it } from 'vitest'
import { DOCUMENT_FAILED, readySession, run } from './mobile-web-shell-session-test-fixtures'

const REMOUNTED = { type: 'remounted', sessionId: 'session-two' } as const
const RENDERER_GONE = { type: 'shell-failed', reason: 'render-process-gone' } as const

describe('a failed document', () => {
  // A page render fault reached delete-and-refetch on every entry and cost a full download each time.
  it('remounts the same files once, then fails, and never deletes them', () => {
    const first = run(readySession().session, DOCUMENT_FAILED)
    expect(first.effects).toEqual([{ kind: 'remount' }])
    expect(first.session.state.kind).toBe('ready')
    const second = run(first.session, REMOUNTED, DOCUMENT_FAILED)
    expect(second.effects).toEqual([])
    expect(second.session.state).toEqual({
      kind: 'failed',
      reason: 'document-load-failed',
      retriedOnce: false
    })
  })

  // Refilling on paint would loop a page that paints and then faults: remount, paint, fault, forever.
  it('fails visibly when the remounted page paints and then faults again', () => {
    const painted = { type: 'page-painted' } as const
    const failed = run(
      readySession().session,
      painted,
      DOCUMENT_FAILED,
      REMOUNTED,
      painted,
      DOCUMENT_FAILED
    )
    expect(failed.effects).toEqual([])
    expect(failed.session.state).toMatchObject({ kind: 'failed', reason: 'document-load-failed' })
  })
})

describe('try again after a failed document', () => {
  it('keeps the cache when the renderer was what failed', () => {
    const failed = run(readySession().session, RENDERER_GONE, REMOUNTED, RENDERER_GONE)
    expect(failed.session.state).toMatchObject({ kind: 'failed', reason: 'render-process-gone' })
    expect(run(failed.session, { type: 'retry-pressed' }).effects).toEqual([{ kind: 'open-cache' }])
  })
})
