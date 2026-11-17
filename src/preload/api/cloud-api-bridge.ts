import { ipcRenderer } from 'electron'
import type { CloudApiAvailability } from '../../shared/cloud-api/cloud-api-types'

/** Desktop only: whether this build has an Orca Cloud control plane. */
export type CloudApiBridge = {
  availability: () => Promise<CloudApiAvailability>
}

export const cloudApiBridge: CloudApiBridge = {
  availability: () => ipcRenderer.invoke('cloudApi:availability')
}
