export type WindowCloseAction = 'allow-confirmed' | 'bypass-gone' | 'request-confirmation'

export type WindowCloseState = {
  /** The renderer already replied to window:close-requested and called close(). */
  windowCloseConfirmed: boolean
  /** webContents emitted render-process-gone (the process is truly gone). */
  rendererProcessGone: boolean
  /** Electron reports the webContents as crashed (isCrashed()). */
  isRendererCrashed: boolean
}

/** Only confirmed or truly gone/crashed renderers bypass save/process guards (#5787/#5144/#5314). Hung-but-live renderers must answer; app quit bounds that wait separately, ordinary close does not. */
export function resolveWindowCloseAction(state: WindowCloseState): WindowCloseAction {
  if (state.windowCloseConfirmed) {
    return 'allow-confirmed'
  }
  if (state.rendererProcessGone || state.isRendererCrashed) {
    return 'bypass-gone'
  }
  return 'request-confirmation'
}
