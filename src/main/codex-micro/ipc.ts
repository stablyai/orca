import { BrowserWindow, ipcMain } from 'electron'
import type { CodexMicroCoordinator } from './coordinator'
import { parseCodexMicroLightingSnapshot } from './lighting-snapshot'

const CHANNELS = [
  'codexMicro:getState',
  'codexMicro:setOutputSnapshot',
  'codexMicro:retry',
  'codexMicro:release'
] as const

export function registerCodexMicroIpc(coordinator: CodexMicroCoordinator): () => void {
  ipcMain.handle('codexMicro:getState', () => coordinator.getState())
  ipcMain.handle('codexMicro:setOutputSnapshot', (_event, args: unknown) => {
    const snapshot = parseCodexMicroLightingSnapshot(args)
    if (!snapshot) {
      throw new Error('Invalid Codex Micro output snapshot')
    }
    coordinator.setOutputSnapshot(snapshot.rgbcfg, snapshot.thstatus)
  })
  ipcMain.handle('codexMicro:retry', () => coordinator.retry())
  ipcMain.handle('codexMicro:release', () => coordinator.release())

  const unsubscribeState = coordinator.subscribeState((state) =>
    broadcast('codexMicro:state', state)
  )
  const unsubscribeInput = coordinator.subscribeInput((event) =>
    broadcast('codexMicro:input', event)
  )

  return () => {
    unsubscribeState()
    unsubscribeInput()
    for (const channel of CHANNELS) {
      ipcMain.removeHandler(channel)
    }
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload)
    }
  }
}
