import type { IpcRenderer } from 'electron'
import { PRELOAD_BROWSER_EXTENSION_FRAME_LIFETIME_CHANNEL } from './browser-extension-api-surface'

export function installBrowserExtensionFrameLifetime(ipcRenderer: IpcRenderer): void {
  let retainedPort: MessagePort | undefined
  ipcRenderer.on(PRELOAD_BROWSER_EXTENSION_FRAME_LIFETIME_CHANNEL, (event) => {
    const [port, ...surplus] = event.ports
    for (const extra of surplus) {
      extra.close()
    }
    if (!port) {
      return
    }
    retainedPort?.close()
    // Retain the isolated-world endpoint until its document is destroyed or it is replaced.
    retainedPort = port
  })
}
