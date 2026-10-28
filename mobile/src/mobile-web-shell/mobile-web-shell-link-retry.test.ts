import { describe, expect, it } from 'vitest'
import {
  afterCacheRead,
  BUNDLE_REFUSED,
  gates,
  LINK_LOST,
  MANIFEST,
  run,
  withoutRecord
} from './mobile-web-shell-session-test-fixtures'

describe('a download the link cut off, with nothing on disk', () => {
  it('downloads again without a tap once the lost link is back, and only then', () => {
    const failed = run(afterCacheRead(null).session, { type: 'download-failed', cause: LINK_LOST })
    const away = run(failed.session, {
      type: 'gates-changed',
      gates: gates({ reachability: 'connecting' })
    })
    expect(away.session.state).toEqual(failed.session.state)
    expect(away.effects).toEqual([])

    const back = run(away.session, { type: 'gates-changed', gates: gates() })
    expect(back.session.state).toEqual({ kind: 'checking' })
    expect(back.effects).toEqual([{ kind: 'open-cache' }])
  })

  it('downloads again on return to the app when the link outlived the time away', () => {
    const failed = run(afterCacheRead(null).session, { type: 'download-failed', cause: LINK_LOST })
    const back = run(failed.session, { type: 'app-foregrounded' })
    expect(back.effects).toEqual([{ kind: 'open-cache' }])
    expect(run(back.session, { type: 'app-foregrounded' }).effects).toEqual([])

    const refused = run(afterCacheRead(null).session, {
      type: 'download-failed',
      cause: BUNDLE_REFUSED
    })
    expect(run(refused.session, { type: 'app-foregrounded' }).effects).toEqual([])
  })

  it('downloads again at once when the link loss lands just after the return', () => {
    const fetching = run(afterCacheRead(null).session, {
      type: 'manifest-read',
      manifest: MANIFEST
    })
    const back = run(fetching.session, { type: 'app-foregrounded' })
    expect(back.effects).toEqual([])
    expect(run(back.session, { type: 'app-foregrounded' }).effects).toEqual([])
    expect(
      run(back.session, { type: 'gates-changed', gates: gates({ reachability: 'connecting' }) })
        .effects
    ).toEqual([])

    const failed = run(back.session, { type: 'download-failed', cause: LINK_LOST })
    expect(failed.session.state).toEqual({ kind: 'checking' })
    expect(withoutRecord(failed.effects)).toEqual([{ kind: 'open-cache' }])
    const again = run(failed.session, { type: 'manifest-read', manifest: MANIFEST })
    expect(
      run(again.session, { type: 'download-failed', cause: LINK_LOST }).session.state
    ).toMatchObject({
      kind: 'failed'
    })
  })

  it('waits for Try again after a host refusal, however the link comes and goes', () => {
    const failed = run(afterCacheRead(null).session, {
      type: 'download-failed',
      cause: BUNDLE_REFUSED
    })
    const away = run(failed.session, {
      type: 'gates-changed',
      gates: gates({ reachability: 'connecting' })
    })
    expect(run(away.session, { type: 'gates-changed', gates: gates() }).effects).toEqual([])
  })

  it('leaves a later terminal failure to its own latches after a return armed the download', () => {
    const fetching = run(afterCacheRead(null).session, {
      type: 'manifest-read',
      manifest: MANIFEST
    })
    const armed = run(fetching.session, { type: 'app-foregrounded' }).session
    const ready = run(armed, {
      type: 'activated',
      generationDirectory: '/cache/mobile-web/host/generations/b',
      sessionId: 'session-one',
      buildId: MANIFEST.buildId,
      totalBytes: MANIFEST.totalBytes,
      elapsedMs: 1
    })
    const failed = run(ready.session, { type: 'shell-failed', reason: 'isolation-unavailable' })
    expect(failed.session.state).toMatchObject({ kind: 'failed', reason: 'isolation-unavailable' })

    expect(run(failed.session, { type: 'app-foregrounded' }).effects).toEqual([])
    const away = run(failed.session, {
      type: 'gates-changed',
      gates: gates({ reachability: 'connecting' })
    })
    expect(run(away.session, { type: 'gates-changed', gates: gates() }).effects).toEqual([])
  })
})
