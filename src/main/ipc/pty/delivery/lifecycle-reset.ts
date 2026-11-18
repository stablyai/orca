import type { PtyRendererDelivery } from '../session'
import {
  didFinishLoadHandler,
  didFinishLoadWebContents,
  rendererDidStartNavigationHandler,
  rendererGateResetGoneHandler,
  rendererGateResetLoadHandler,
  rendererGateResetWebContents,
  rendererLifecycleResetHandler,
  rendererLifecycleResetWebContents,
  setDidFinishLoadHandler,
  setRendererGateResetState,
  setRendererLifecycleResetState
} from '../provider/listener-lifecycle'
import { mainDeliveryBreadcrumbs, resetRendererDeliveryAccountingForLifecycleReset } from './debug'
import {
  activeRendererPtys,
  invalidatePendingPtyDrainPriority,
  visibleRendererPtys
} from './visibility-state'

export function clearDidFinishLoadHandler(): void {
  if (didFinishLoadHandler && didFinishLoadWebContents) {
    didFinishLoadWebContents.removeListener('did-finish-load', didFinishLoadHandler)
  }
  setDidFinishLoadHandler(null, null)
}

export function markRendererPtysHiddenForRendererLifecycleReset(): void {
  mainDeliveryBreadcrumbs.record('renderer-lifecycle-reset')
  // Visibility hints belong to the dead page; surviving PTYs must wait for fresh reports.
  const activePriorityChanged = activeRendererPtys.size > 0
  activeRendererPtys.clear()
  visibleRendererPtys.clear()
  // The dead page cannot ACK; retire its accounting so surviving PTYs do not remain gated.
  resetRendererDeliveryAccountingForLifecycleReset()
  if (activePriorityChanged) {
    invalidatePendingPtyDrainPriority()
  }
}

export function clearRendererLifecycleResetHandlers(): void {
  if (!rendererLifecycleResetWebContents) {
    return
  }
  if (rendererDidStartNavigationHandler) {
    rendererLifecycleResetWebContents.removeListener(
      'did-start-navigation',
      rendererDidStartNavigationHandler
    )
  }
  if (rendererLifecycleResetHandler) {
    rendererLifecycleResetWebContents.removeListener(
      'render-process-gone',
      rendererLifecycleResetHandler
    )
    rendererLifecycleResetWebContents.removeListener('destroyed', rendererLifecycleResetHandler)
  }
  setRendererLifecycleResetState({ contents: null, handler: null, navigation: null })
}

export function registerRendererLifecycleResetHandlers(
  webContents?: PtyRendererDelivery['webContents']
): void {
  clearRendererLifecycleResetHandlers()
  markRendererPtysHiddenForRendererLifecycleReset()
  if (!webContents) {
    return
  }
  const handler = markRendererPtysHiddenForRendererLifecycleReset
  const navigationHandler = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
    if (!details.isMainFrame || details.isSameDocument) {
      return
    }
    markRendererPtysHiddenForRendererLifecycleReset()
  }
  setRendererLifecycleResetState({
    contents: webContents,
    handler,
    navigation: navigationHandler
  })
  webContents.on('did-start-navigation', navigationHandler)
  webContents.on('render-process-gone', handler)
  webContents.on('destroyed', handler)
}

export function clearRendererGateResetHandlers(): void {
  if (rendererGateResetWebContents) {
    if (rendererGateResetLoadHandler) {
      rendererGateResetWebContents.removeListener('did-finish-load', rendererGateResetLoadHandler)
    }
    if (rendererGateResetGoneHandler) {
      rendererGateResetWebContents.removeListener(
        'render-process-gone',
        rendererGateResetGoneHandler
      )
    }
  }
  setRendererGateResetState({ contents: null, load: null, gone: null })
}
