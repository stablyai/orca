import type { BrowserWindow } from 'electron'

export function emitCloneProgressFromText(mainWindow: BrowserWindow, text: string): void {
  for (const line of text.split(/[\r\n]+/)) {
    const match = line.match(/^([\w\s]+):\s+(\d+)%/)
    if (match && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('repos:clone-progress', {
        phase: match[1].trim(),
        percent: Number.parseInt(match[2], 10)
      })
    }
  }
}
