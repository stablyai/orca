import { ipcRenderer } from 'electron'
import type { CredentialVaultApi } from '../../shared/secure-storage/credential-vault'

export const credentialVaultApi: CredentialVaultApi = {
  list: (target) => ipcRenderer.invoke('credentialVault:list', undefined, target),
  save: (draft, target) => ipcRenderer.invoke('credentialVault:save', draft, target),
  remove: (id, target) => ipcRenderer.invoke('credentialVault:remove', id, target),
  copy: (id, target) => ipcRenderer.invoke('credentialVault:copy', id, target),
  changeBotTool: (change, target) =>
    ipcRenderer.invoke('credentialVault:changeBotTool', change, target)
}
