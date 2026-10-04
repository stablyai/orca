import { describe, expect, it } from 'vitest'
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

function frame(patch: { state?: MobileWebShellSessionState; pagePainted?: boolean }) {
  return shellPageFrame({ state: patch.state ?? READY, pagePainted: patch.pagePainted ?? false })
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

  it('covers a mounted view until the page reports a frame, handshake or not', () => {
    // `ready` is posted before the tree is built, so the view is mounted, empty and showing the
    // surface behind it for every frame between the two.
    expect(frame({})).toBe('unpainted')
  })

  it('uncovers on the page reporting a frame', () => {
    expect(frame({ pagePainted: true })).toBe('painted')
  })
})
