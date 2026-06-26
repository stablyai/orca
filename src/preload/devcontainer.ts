/* Devcontainer preload bindings — split out of `src/preload/index.ts` for the
   same reason as the GitLab bindings (smaller merge surface on upstream sync).
   Composed back into `api.devcontainer` from `index.ts`. */
import { ipcRenderer } from 'electron'
import type { DevcontainerInfo } from '../shared/devcontainer-types'

export type { DevcontainerInfo }

export const devcontainerApi = {
  /** List devcontainers to offer in the Add-Project "Devcontainer" source. */
  list: (): Promise<DevcontainerInfo[]> => ipcRenderer.invoke('devcontainer:list')
}
