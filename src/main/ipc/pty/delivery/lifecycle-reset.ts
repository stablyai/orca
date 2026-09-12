import type { WebContents } from 'electron'
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
  // A reload/crash in the breadcrumb history is load-bearing context for any freeze report.
  mainDeliveryBreadcrumbs.record('renderer-lifecycle-reset')
  // Why: renderer-owned hints die with the page; clear visibility so surviving daemon/SSH PTYs fail closed until the new renderer reports.
  const activePriorityChanged = activeRendererPtys.size > 0
  activeRendererPtys.clear()
  visibleRendererPtys.clear()
  // Why: the dead page never ACKs its in-flight bytes, so leaked accounting would delivery-gate surviving PTYs forever after a reload/crash.
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

export function registerRendererLifecycleResetHandlers(webContents: WebContents): void {
  clearRendererLifecycleResetHandlers()
  markRendererPtysHiddenForRendererLifecycleReset()
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
