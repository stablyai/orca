import { BrowserWindow } from 'electron'
import type { HerdrImportedSurface } from './herdr-orca-surface-import'
import type { HerdrOrcaSurfaceAction } from './herdr-orca-surface-sync'

function eachWindow(send: (contents: Electron.WebContents) => void): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      send(win.webContents)
    }
  }
}

export function presentHerdrImportedSurface(surface: HerdrImportedSurface): void {
  eachWindow((contents) => {
    contents.send('ui:createTerminal', {
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
  })
}

export function presentHerdrSurfaceAction(action: HerdrOrcaSurfaceAction): void {
  eachWindow((contents) => {
    if (action.kind === 'rename') {
      contents.send('ui:renameTerminal', { tabId: action.tabId, title: action.title })
      return
    }
    if (action.kind === 'focus') {
      contents.send('ui:focusTerminal', {
        tabId: action.tabId,
        worktreeId: action.worktreeId,
        leafId: action.leafId
      })
      return
    }
    if (action.kind === 'close') {
      contents.send('ui:closeTerminal', { tabId: action.tabId })
      return
    }
    contents.send('ui:applyTerminalLayout', { tabId: action.tabId, layout: action.layout })
  })
}
