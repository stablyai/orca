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

  // #5787: hung-but-live renderers still need save/process confirmation; only proven gone/crashed renderers may bypass.
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
    // A confirmed close must proceed rather than request confirmation again.
    expect(
      resolveWindowCloseAction({
        windowCloseConfirmed: true,
        rendererProcessGone: true,
        isRendererCrashed: true
      })
    ).toBe('allow-confirmed')
  })
})
