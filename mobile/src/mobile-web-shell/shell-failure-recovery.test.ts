import { describe, expect, it } from 'vitest'
import { DOCUMENT_FAILED, readySession, run } from './mobile-web-shell-session-test-fixtures'

const REMOUNTED = { type: 'remounted', sessionId: 'session-two' } as const
const RENDERER_GONE = { type: 'shell-failed', reason: 'render-process-gone' } as const

describe('a failed document', () => {
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

describe('a renderer the OS reclaimed', () => {
  // Background jetsam remounts with no frames to paint, so a second background loss used to wall on return.
  it('remounts without spending the one remount a crashing renderer gets', () => {
    const reclaimed = { ...RENDERER_GONE, reclaimed: true } as const
    const lost = run(readySession().session, reclaimed, REMOUNTED, RENDERER_GONE)
    expect(lost.effects).toEqual([{ kind: 'remount' }])
    expect(lost.session.state.kind).toBe('ready')
  })
})
