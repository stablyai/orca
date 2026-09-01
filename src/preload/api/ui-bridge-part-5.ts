import { ipcRenderer } from 'electron'

export const uiApiPart5 = {
  notifyWindowRevealed: (): void => {
    ipcRenderer.send('ui:window-revealed')
  }
}
