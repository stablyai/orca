import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'

let trustedRendererWebContentsId: number | null = null

export function setTrustedRendererWebContentsId(webContentsId: number | null): void {
  trustedRendererWebContentsId = webContentsId
}

export function isTrustedRendererSender(sender: WebContents | undefined): boolean {
  if (!sender || sender.isDestroyed?.()) {
    return false
  }
  if (trustedRendererWebContentsId !== null) {
    return sender.id === trustedRendererWebContentsId
  }
  if (sender.getType?.() !== 'window') {
    return false
  }
  const senderUrl = sender.getURL?.() ?? ''
  if (process.env.ELECTRON_RENDERER_URL) {
    try {
      return new URL(senderUrl).origin === new URL(process.env.ELECTRON_RENDERER_URL).origin
    } catch {
      return false
    }
  }
  return senderUrl.startsWith('file://')
}

export function assertTrustedRendererSender(
  event: IpcMainEvent | IpcMainInvokeEvent,
  channel: string
): void {
  // Why: high-power desktop IPC channels must not be callable by webview or
  // offscreen browser content if raw IPC is ever accidentally exposed.
  if (!isTrustedRendererSender(event.sender)) {
    throw new Error(`${channel} must originate from the trusted Orca renderer`)
  }
}

export function handleTrustedRenderer<TArgs extends unknown[], TResult>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult
): void {
  ipcMain.handle(channel, (event, ...args: TArgs): TResult => {
    assertTrustedRendererSender(event, channel)
    return handler(event, ...args)
  })
}
