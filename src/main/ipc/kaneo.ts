import { CancellableProviderRequests } from './cancellable-provider-requests'
import { ipcMain } from 'electron'
import { connectKaneo, getKaneoTask } from '../kaneo/client'
import { disconnectKaneo, getKaneoStatus } from '../kaneo/credential-store'
import { KaneoConnectSchema, KaneoTaskUrlSchema } from '../../shared/kaneo-schemas'

export function registerKaneoHandlers(): void {
  const requests = new CancellableProviderRequests()
  ipcMain.handle('kaneo:status', () => getKaneoStatus())
  ipcMain.handle('kaneo:connect', (_event, args: unknown) =>
    connectKaneo(KaneoConnectSchema.parse(args))
  )
  ipcMain.handle('kaneo:disconnect', () => disconnectKaneo())
  ipcMain.handle('kaneo:getTask', (event, args: unknown) => {
    const { url, requestId } = KaneoTaskUrlSchema.parse(args)
    return requests.run(requestId ? `${event.sender.id}:${requestId}` : undefined, (signal) =>
      getKaneoTask(url, signal)
    )
  })
  ipcMain.handle('kaneo:cancelTask', (event, args: { requestId?: unknown }) => {
    if (typeof args?.requestId === 'string' && args.requestId.length <= 100) {
      requests.cancel(`${event.sender.id}:${args.requestId}`)
    }
  })
}
