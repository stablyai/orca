import { describe, expect, it } from 'vitest'
import { resolveWindowCloseAction } from './window-close-decision'

describe('resolveWindowCloseAction', () => {
  it('allows a renderer-confirmed close', () => {
    expect(
      resolveWindowCloseAction({
        windowCloseConfirmed: true,
        rendererProcessGone: false,
        isRendererCrashed: false
      })
    ).toBe('allow-confirmed')
  })

  it('bypasses confirmation only when the renderer is truly gone or crashed', () => {
    expect(
      resolveWindowCloseAction({
        windowCloseConfirmed: false,
        rendererProcessGone: true,
        isRendererCrashed: false
      })
    ).toBe('bypass-gone')
    expect(
      resolveWindowCloseAction({
        windowCloseConfirmed: false,
        rendererProcessGone: false,
        isRendererCrashed: true
      })
    ).toBe('bypass-gone')
  })

  // Why (#5787): the data-loss cascade — a HUNG but alive renderer (force-killed
  // via the OS "not responding" dialog) must still route through the renderer's
  // save/running-process confirmation. It is neither gone nor crashed at the
  // moment the user decides to close, so it MUST request confirmation, not bypass.
  it('requests confirmation for an alive renderer (no gone/crashed flag)', () => {
    expect(
      resolveWindowCloseAction({
        windowCloseConfirmed: false,
        rendererProcessGone: false,
        isRendererCrashed: false
      })
    ).toBe('request-confirmation')
  })

  it('prefers the confirmed-close path even if a stale gone/crashed flag is set', () => {
    // Why: a renderer that already confirmed close (windowCloseConfirmed) is
    // proceeding through the normal teardown; never re-route it.
    expect(
      resolveWindowCloseAction({
        windowCloseConfirmed: true,
        rendererProcessGone: true,
        isRendererCrashed: true
      })
    ).toBe('allow-confirmed')
  })
})
