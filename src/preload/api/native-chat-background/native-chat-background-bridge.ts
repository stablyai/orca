import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../../api-types'
import type { NativeChatBackgroundImage } from './native-chat-background-api'

export const nativeChatBackgroundApi = {
  import: (): Promise<string | null> => ipcRenderer.invoke('nativeChatBackground:import'),
  read: (fileName: string): Promise<NativeChatBackgroundImage | null> =>
    ipcRenderer.invoke('nativeChatBackground:read', fileName),
  delete: (fileName: string): Promise<void> =>
    ipcRenderer.invoke('nativeChatBackground:delete', fileName)
} satisfies PreloadApi['nativeChatBackground']
