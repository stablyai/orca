import { ipcRenderer } from 'electron'
import type { KeybindingActionId, KeybindingFileSnapshot } from '../../shared/keybindings'
import type { PreloadApi } from '../api-types'

export const keybindingsApi = {
  get: (): Promise<KeybindingFileSnapshot> => ipcRenderer.invoke('keybindings:get'),
  ensureFile: (): Promise<KeybindingFileSnapshot> => ipcRenderer.invoke('keybindings:ensureFile'),
  setAction: (args: {
    actionId: KeybindingActionId
    bindings: string[] | null
  }): Promise<KeybindingFileSnapshot> => ipcRenderer.invoke('keybindings:setAction', args),
  reload: (): Promise<KeybindingFileSnapshot> => ipcRenderer.invoke('keybindings:reload'),
  openFile: (): Promise<KeybindingFileSnapshot> => ipcRenderer.invoke('keybindings:openFile'),
  revealFile: (): Promise<KeybindingFileSnapshot> => ipcRenderer.invoke('keybindings:revealFile'),
  onChanged: (callback: (snapshot: KeybindingFileSnapshot) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: KeybindingFileSnapshot): void =>
      callback(snapshot)
    ipcRenderer.on('keybindings:changed', listener)
    return () => ipcRenderer.removeListener('keybindings:changed', listener)
  }
} satisfies PreloadApi['keybindings']
