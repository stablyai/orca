import { ipcMain } from 'electron'
import type * as NativeChatIpc from './native-chat'
import { registerLazyIpcHandleGroup } from './lazy-ipc-handle-group'

const NATIVE_CHAT_HANDLE_CHANNELS = [
  'nativeChat:readSession',
  'nativeChat:conversationNameFailureOutput'
] as const

export function registerLazyNativeChatHandlers(): void {
  let loadedModule: Promise<typeof NativeChatIpc> | null = null
  const loadModule = (): Promise<typeof NativeChatIpc> => {
    if (!loadedModule) {
      loadedModule = import('./native-chat').catch((error: unknown) => {
        loadedModule = null
        throw error
      })
    }
    return loadedModule
  }

  registerLazyIpcHandleGroup(NATIVE_CHAT_HANDLE_CHANNELS, async (ipc) => {
    const mod = await loadModule()
    mod.registerNativeChatHandleChannels(ipc)
  })

  ipcMain.on('nativeChat:subscribe', (event, args: NativeChatIpc.NativeChatSubscribeArgs) => {
    void loadModule()
      .then((mod) => {
        mod.handleNativeChatSubscribeEvent(event, args)
      })
      .catch(() => undefined)
  })

  ipcMain.on('nativeChat:unsubscribe', (event, args: { subscriptionId: string }) => {
    if (!loadedModule) {
      return
    }
    const senderId = event.sender.id
    void loadedModule
      .then((mod) => {
        mod.teardownSubscription(senderId, args.subscriptionId)
      })
      .catch(() => undefined)
  })
}
