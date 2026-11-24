import {
  BRIDGE_MAX_SAFE_AREA_INSET,
  type BridgeSafeAreaInsets
} from '../bridge/page-geometry/bridge-safe-area-insets'

let probe: HTMLElement | null = null

// env() only reports a notch or home bar once the page asks to be drawn under them.
function coverViewport(): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
  if (meta && !meta.content.includes('viewport-fit')) {
    meta.content = `${meta.content}, viewport-fit=cover`
  }
}

// env() is readable only through layout, so a hidden element carries it as padding.
function safeAreaProbe(): HTMLElement {
  if (probe === null) {
    coverViewport()
    probe = document.createElement('div')
    probe.setAttribute('aria-hidden', 'true')
    probe.style.cssText =
      'position:fixed;visibility:hidden;pointer-events:none;top:0;left:0;' +
      'padding:env(safe-area-inset-top) env(safe-area-inset-right) ' +
      'env(safe-area-inset-bottom) env(safe-area-inset-left)'
    document.body.appendChild(probe)
  }
  return probe
}

const inset = (value: string) =>
  Math.min(BRIDGE_MAX_SAFE_AREA_INSET, Math.max(0, Number.parseFloat(value) || 0))

export function readBrowserSafeAreaInsets(): BridgeSafeAreaInsets {
  const style = getComputedStyle(safeAreaProbe())
  return {
    top: inset(style.paddingTop),
    right: inset(style.paddingRight),
    bottom: inset(style.paddingBottom),
    left: inset(style.paddingLeft)
  }
}

// A keyboard shrinks the visual viewport but not the layout one the page fills.
export function readBrowserKeyboardInset(): number {
  const viewport = window.visualViewport
  if (!viewport) {
    return 0
  }
  return Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop))
}
