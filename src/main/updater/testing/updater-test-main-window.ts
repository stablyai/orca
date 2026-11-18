import type { BrowserWindow } from 'electron'

export function updaterMainWindow(
  send: (channel: string, ...args: unknown[]) => void
): BrowserWindow {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the updater reaches its window only through isDestroyed and webContents.isDestroyed/send.
  return {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send }
  } as unknown as BrowserWindow
}
