import { useLayoutEffect } from 'react'
import { useAppStore } from '@/store/index'
import {
  stepUIZoomLevel,
  uiZoomFactorFromLevel,
  zoomLevelToPercent,
  type UIZoomDirection,
  type UIZoomRegion
} from '../../../../shared/app-lifecycle/windows/ui-zoom-level'
import { applyPanelZoom } from './ui-zoom'
import { dispatchZoomLevelChanged } from './zoom-events'

export function changeRegionZoom(region: UIZoomRegion, direction: UIZoomDirection): void {
  const state = useAppStore.getState()
  if (!state.persistedUIReady) {
    return
  }
  const sidebar = region === 'sidebar'
  const next = stepUIZoomLevel(sidebar ? state.sidebarZoomLevel : state.uiZoomLevel, direction)
  if (sidebar) {
    state.setSidebarZoomLevel(next)
  } else {
    state.setUIZoomLevel(next)
  }
  dispatchZoomLevelChanged(region, zoomLevelToPercent(next))
}

export function useRegionZoom(): void {
  const ready = useAppStore((state) => state.persistedUIReady)
  const panel = useAppStore((state) => state.uiZoomLevel)
  const sidebar = useAppStore((state) => state.sidebarZoomLevel)

  useLayoutEffect(() => {
    if (ready) {
      applyPanelZoom(panel)
    }
  }, [ready, panel])

  useLayoutEffect(() => {
    if (ready) {
      document.documentElement.style.setProperty(
        '--sidebar-zoom-ratio',
        String(uiZoomFactorFromLevel(sidebar - panel))
      )
    }
  }, [ready, sidebar, panel])
}
