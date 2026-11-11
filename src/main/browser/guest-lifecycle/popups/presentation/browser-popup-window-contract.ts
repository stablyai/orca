// Electron supplies an untyped webContents option; adopting it preserves OAuth opener/session state.
export type PopupChildWindowOptions = Electron.BrowserWindowConstructorOptions & {
  webContents?: Electron.WebContents
  nativeWindow?: Electron.BrowserWindow
  // Cmd/Ctrl+Shift-click supplies no page; only GET requests can be reloaded by URL.
  loadInitialUrl?: boolean
}

export type PopupOriginBarWindow = {
  contentWebContents: Electron.WebContents
  close: () => void
  onClosed: (listener: () => void) => void
}
