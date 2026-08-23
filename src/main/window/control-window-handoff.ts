import type { BrowserWindow } from 'electron'
import type { OrcaWindowManager } from './orca-window-manager'

type ControlWindowHandoffOptions = {
  windows: OrcaWindowManager
  isCurrentControl: () => boolean
  getIsQuitting: () => boolean
  onWindowClosed: () => void
  fenceAndSettleTransfers?: () => Promise<void>
  markGraphUnavailable?: (windowId: number) => void
  attachRuntimeWindow?: (window: BrowserWindow) => void
  releaseTransferFence?: () => void
  onHandoff: (window: BrowserWindow) => void
  onVacated: () => void
}

export function bindControlWindowHandoff(
  controlWindow: BrowserWindow,
  options: ControlWindowHandoffOptions
): void {
  const transitionToken = options.windows.beginControlTransition(controlWindow.id)
  const finishHandoff = (): boolean | null => {
    const promoted =
      options.getIsQuitting() || transitionToken == null
        ? null
        : options.windows.electControlDuringTransition(transitionToken)
    if (transitionToken == null || !options.windows.finishControlTransition(transitionToken)) {
      return null
    }
    options.markGraphUnavailable?.(controlWindow.id)
    if (promoted) {
      try {
        options.attachRuntimeWindow?.(promoted)
        options.onHandoff(promoted)
        return true
      } catch {
        options.markGraphUnavailable?.(promoted.id)
      }
    }
    return false
  }
  controlWindow.on('closed', () => {
    if (!options.isCurrentControl()) {
      return
    }
    options.onWindowClosed()
    const pendingTransfers = options.fenceAndSettleTransfers?.()
    if (!pendingTransfers) {
      if (finishHandoff() === false) {
        options.onVacated()
      }
      return
    }
    void pendingTransfers
      .then(finishHandoff, () => false)
      .then((completed) => {
        if (completed) {
          options.releaseTransferFence?.()
        } else if (completed === false) {
          options.onVacated()
        }
      })
  })
}
