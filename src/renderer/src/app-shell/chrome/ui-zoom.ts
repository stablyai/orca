import { uiZoomFactorFromLevel } from '../../../../shared/app-lifecycle/windows/ui-zoom-level'
import { isPairedWebClientWindow } from './desktop-window-chrome'

/** Mirror UI zoom for fixed-DIP CSS compensation, including main.css traffic-light padding. */
const UI_ZOOM_FACTOR_CSS_VAR = '--ui-zoom-factor'

/** Scale applied to this renderer's CSS pixels, or the persisted level in the web client. */
export function getUIZoomFactor(): number {
  return uiZoomFactorFromLevel(window.api?.ui?.getZoomLevel?.() ?? 0)
}

/** Convert window DIP to CSS pixels for exact native-sized boxes, such as emulated guest viewports. */
export function windowDipToCssPx(dip: number): number {
  return dip / getUIZoomFactor()
}

export function applyPanelZoom(level: number): void {
  const factor = uiZoomFactorFromLevel(level)
  const root = document.documentElement
  const isWeb = isPairedWebClientWindow()
  if (window.api.ui.getZoomLevel() !== level) {
    window.api.ui.setZoomLevel(level)
  }
  root.style.setProperty(UI_ZOOM_FACTOR_CSS_VAR, String(factor))
  if (isWeb) {
    root.style.zoom = String(factor)
    root.style.setProperty('--web-panel-zoom', String(factor))
  } else {
    window.api.ui.syncPanelZoom()
  }
}
