import { describe, expect, it } from 'vitest'
import {
  CACHED,
  DOCUMENT_FAILED,
  MANIFEST,
  gates,
  readySession,
  run
} from '../test-support/mobile-web-shell-session-test-fixtures'

const REMOUNTED = { type: 'remounted', sessionId: 'session-two' } as const
const RENDERER_GONE = { type: 'shell-failed', reason: 'render-process-gone' } as const
const PAINTED = { type: 'page-painted' } as const

describe('a failed document', () => {
  // Refilling on paint would loop a page that paints and then faults: remount, paint, fault, forever.
  it('fails visibly when the remounted page paints and then faults again', () => {
    const failed = run(
      readySession().session,
      PAINTED,
      DOCUMENT_FAILED,
      REMOUNTED,
      PAINTED,
      DOCUMENT_FAILED
    )
    expect(failed.effects).toEqual([])
    expect(failed.session.state).toMatchObject({ kind: 'failed', reason: 'document-load-failed' })
  })
})

describe('a runtime page fault', () => {
  const PAGE_FAULT = { type: 'shell-failed', reason: 'page-fault' } as const
  const CACHED_ACTIVATED = {
    type: 'activated',
    generationDirectory: CACHED.directory,
    sessionId: 'session-three',
    buildId: CACHED.buildId,
    totalBytes: MANIFEST.totalBytes,
    elapsedMs: 5
  } as const

  function failedAfterPaint(session = readySession().session) {
    return run(session, PAINTED, PAGE_FAULT, REMOUNTED, PAINTED, PAGE_FAULT)
  }

  // #45836: a page bug after paint redownloaded the whole bundle on every Try again.
  it('keeps the cached bundle on try again once the page painted', () => {
    const failed = failedAfterPaint()
    expect(failed.session.state).toMatchObject({ kind: 'failed', reason: 'page-fault' })

    const retried = run(failed.session, { type: 'retry-pressed' })
    expect(retried.effects).toEqual([{ kind: 'open-cache' }])
    const asked = run(retried.session, { type: 'cache-read', generation: CACHED })
    expect(asked.effects).toEqual([{ kind: 'read-manifest' }])

    const same = run(asked.session, { type: 'manifest-read', manifest: MANIFEST })
    expect(same.effects.map((effect) => effect.kind)).toEqual(['open-generation'])
  })

  // A lazy chunk damaged on disk faults after paint on every reopen; the second Try again must redownload, as before #45836.
  it('redownloads on try again when the reopened build faults again after paint', () => {
    const failed = failedAfterPaint()
    const reopened = run(
      failed.session,
      { type: 'retry-pressed' },
      { type: 'cache-read', generation: CACHED },
      { type: 'manifest-read', manifest: MANIFEST }
    )
    const openedAgain = reopened.effects.find((effect) => effect.kind === 'open-generation')
    expect(openedAgain).toMatchObject({ buildId: CACHED.buildId })

    const ready = run(reopened.session, CACHED_ACTIVATED)
    expect(ready.session.state.kind).toBe('ready')

    const faultedAgain = failedAfterPaint(ready.session)
    expect(faultedAgain.session.state).toMatchObject({
      kind: 'failed',
      reason: 'document-load-failed'
    })
    expect(run(faultedAgain.session, { type: 'retry-pressed' }).effects).toEqual([
      { kind: 'delete-cache' },
      { kind: 'open-cache' }
    ])
  })

  // The cached build opens before the host answers, and each remount cancels the update staging behind it.
  it('downloads the host build on try again when it differs from the faulting cache', () => {
    const failed = failedAfterPaint()
    const fixed = { ...MANIFEST, buildId: 'fixed-build' }

    const retried = run(
      failed.session,
      { type: 'retry-pressed' },
      { type: 'cache-read', generation: CACHED },
      { type: 'manifest-read', manifest: fixed }
    )
    expect(retried.effects).toEqual([{ kind: 'download' }])
  })

  // Try again while dialling opens the cache unasked; a later swap must not still wait on the manifest.
  it('spends the ask-first on the first cache read even when the host is not answering', () => {
    const failed = failedAfterPaint()
    const dialling = { ...failed.session, gates: gates({ reachability: 'connecting' }) }
    const opened = run(
      dialling,
      { type: 'retry-pressed' },
      { type: 'cache-read', generation: CACHED },
      CACHED_ACTIVATED,
      { type: 'gates-changed', gates: gates() }
    )
    expect(opened.session.state.kind).toBe('ready')

    const swapped = run(
      opened.session,
      { type: 'update-swap' },
      { type: 'cache-read', generation: CACHED }
    )
    expect(swapped.effects.map((effect) => effect.kind)).toEqual(['open-generation'])
  })

  // A chunk that fails before any screen paints may be damaged; Try again must not reopen it.
  it('redownloads on try again when the page never painted', () => {
    const failed = run(readySession().session, PAGE_FAULT, REMOUNTED, PAGE_FAULT)
    expect(failed.session.state).toMatchObject({ kind: 'failed', reason: 'document-load-failed' })

    expect(run(failed.session, { type: 'retry-pressed' }).effects).toEqual([
      { kind: 'delete-cache' },
      { kind: 'open-cache' }
    ])
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
