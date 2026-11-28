import { ipcMain, shell } from 'electron'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import { systemBrowserUrlForForward } from '../../ports/forwarded-url-system-browser'
import {
  isForwardedUrlOpenRequest,
  type ForwardedUrlOpenResult
} from '../../../shared/workspace/ports/forwarded-url-open'

export function registerForwardedUrlOpenHandler(ipc: IpcHandleRegistrar = ipcMain): void {
  ipc.handle(
    'shell:openForwardedUrl',
    async (_event, request: unknown): Promise<ForwardedUrlOpenResult> => {
      if (!isForwardedUrlOpenRequest(request)) {
        return { opened: false }
      }
      const target = await systemBrowserUrlForForward(request)
      if (!target) {
        return { opened: false }
      }
      const url = target.url.toString()
      await shell.openExternal(url)
      return { opened: true, url, movedToIpv4: target.movedToIpv4 }
    }
  )
}
