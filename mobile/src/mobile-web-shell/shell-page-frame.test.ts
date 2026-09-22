import { describe, expect, it } from 'vitest'
import { BRIDGE_PAGE_PAINTED } from './bridge/bridge-page-painted'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'
import { shellPageFrame } from './shell-page-frame'

const READY: MobileWebShellSessionState = {
  kind: 'ready',
  generationDirectory: '/cache/gen',
  sessionId: 'session-a',
  buildId: 'build-a',
  totalBytes: 1,
  elapsedMs: 1
}

function frame(patch: {
  state?: MobileWebShellSessionState
  pageReady?: boolean
  pageReportsPaint?: boolean
  pagePainted?: boolean
}) {
  return shellPageFrame({
    state: patch.state ?? READY,
    pageReady: patch.pageReady ?? false,
    pageReportsPaint: patch.pageReportsPaint ?? false,
    pagePainted: patch.pagePainted ?? false
  })
}

describe('how long the shell keeps its own frame up', () => {
  it('has nothing to cover before a generation is on screen', () => {
    for (const state of [
      { kind: 'checking' },
      { kind: 'activating', source: 'download' },
      { kind: 'offline' },
      { kind: 'native-route' }
    ] as const satisfies readonly MobileWebShellSessionState[]) {
      expect(frame({ state }), state.kind).toBe('pending')
    }
  })

  it('covers a mounted view that has said nothing, which is the whole of the page boot', () => {
    expect(frame({})).toBe('unpainted')
  })

  it('keeps covering a page that has handshaken and not yet painted', () => {
    // The gap this exists for: `ready` is posted before the tree is built, so the view is mounted,
    // empty and showing the surface behind it for every frame between the two.
    expect(frame({ pageReady: true, pageReportsPaint: true })).toBe('unpainted')
  })

  it('new shell, new page: uncovers on the page reporting a frame', () => {
    expect(frame({ pageReady: true, pageReportsPaint: true, pagePainted: true })).toBe('painted')
  })

  it('new shell, old page: uncovers on ready, the newest word that page will ever say', () => {
    // A generation served by a desktop built before the report exists. Waiting on a frame it
    // cannot send would hide a working workspace for the life of the document.
    expect(frame({ pageReady: true, pageReportsPaint: false })).toBe('painted')
  })

  it('reads the declaration off the list the page sent, not off the shell', () => {
    // The name is what the page puts in `ready.reports`, so the frame follows that list and not a
    // flag the shell set: a list without it is a page whose newest word is `ready`.
    const declared = [BRIDGE_PAGE_PAINTED].includes(BRIDGE_PAGE_PAINTED)
    expect(frame({ pageReady: true, pageReportsPaint: declared })).toBe('unpainted')
    expect(
      frame({ pageReady: true, pageReportsPaint: ['other'].includes(BRIDGE_PAGE_PAINTED) })
    ).toBe('painted')
  })
})
