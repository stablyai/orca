import type { BrowserWindow } from 'electron'
import type { OrcaWindowManager } from './orca-window-manager'

type ControlWindowHandoffOptions = {
  windows: OrcaWindowManager
  isCurrentControl: () => boolean
  getIsQuitting: () => boolean
  onWindowClosed: () => void
  onHandoff: (window: BrowserWindow) => void
  onVacated: () => void
}

export function bindControlWindowHandoff(
  controlWindow: BrowserWindow,
  options: ControlWindowHandoffOptions
): void {
  const transitionToken = options.windows.beginControlTransition(controlWindow.id)
  controlWindow.on('closed', () => {
    if (!options.isCurrentControl()) {
      return
    }
    options.onWindowClosed()
    const promoted =
      options.getIsQuitting() || transitionToken == null
        ? null
        : options.windows.electControlDuringTransition(transitionToken)
    if (transitionToken == null || !options.windows.finishControlTransition(transitionToken)) {
      return
    }
    if (promoted) {
      options.onHandoff(promoted)
    } else {
      options.onVacated()
    }
  })
}
