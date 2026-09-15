import type { BrowserWindow } from 'electron'
import type { MonitorDisplay, WindowPlacement } from './monitor-placement'
import { readMonitorDisplays, recoverWindowPlacement } from './monitor-placement'

type ScreenEvents = {
  on(event: 'display-removed' | 'display-metrics-changed', listener: () => void): unknown
  removeListener(
    event: 'display-removed' | 'display-metrics-changed',
    listener: () => void
  ): unknown
}

export function installMonitorTopologyRecovery(args: {
  displays: () => readonly MonitorDisplay[]
  screen: ScreenEvents
  window: BrowserWindow
  onRecovered?: (bounds: WindowPlacement, maximized: boolean) => void
}): () => void {
  const recover = (): void => {
    if (args.window.isDestroyed() || args.window.isFullScreen() || args.window.isMinimized()) {
      return
    }
    const maximized = args.window.isMaximized()
    if (maximized && !args.window.isVisible()) {
      return
    }
    const bounds = maximized ? args.window.getNormalBounds() : args.window.getBounds()
    const recovered = recoverWindowPlacement(bounds, readMonitorDisplays(args.displays))
    if (
      recovered.x === bounds.x &&
      recovered.y === bounds.y &&
      recovered.width === bounds.width &&
      recovered.height === bounds.height
    ) {
      return
    }
    if (maximized) {
      args.window.unmaximize()
    }
    args.window.setBounds(recovered)
    if (maximized) {
      args.window.maximize()
    }
    args.onRecovered?.(recovered, maximized)
  }
  const dispose = (): void => {
    args.window.removeListener('restore', recover)
    args.window.removeListener('leave-full-screen', recover)
    args.window.removeListener('show', recover)
    args.screen.removeListener('display-removed', recover)
    args.screen.removeListener('display-metrics-changed', recover)
  }
  args.screen.on('display-removed', recover)
  args.screen.on('display-metrics-changed', recover)
  args.window.on('restore', recover)
  args.window.on('leave-full-screen', recover)
  args.window.on('show', recover)
  args.window.on('closed', () => {
    args.screen.removeListener('display-removed', recover)
    args.screen.removeListener('display-metrics-changed', recover)
  })
  return dispose
}
