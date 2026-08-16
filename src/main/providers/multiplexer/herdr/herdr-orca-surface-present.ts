import { BrowserWindow } from 'electron'
import type { HerdrImportedSurface } from './herdr-orca-surface-import'

export function presentHerdrImportedSurface(surface: HerdrImportedSurface): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) {
      continue
    }
    win.webContents.send('ui:createTerminal', {
      worktreeId: surface.worktreeId,
      ptyId: surface.ptyId,
      tabId: surface.tabId,
      leafId: surface.leafId,
      title: surface.title,
      ...(surface.cwd ? { cwd: surface.cwd } : {}),
      activate: false,
      focus: false,
      presentation: 'background',
      ...(surface.splitFromLeafId
        ? {
            splitFromLeafId: surface.splitFromLeafId,
            splitDirection: surface.splitDirection ?? 'vertical'
          }
        : {})
    })
  }
}
