import { ipcRenderer } from 'electron'
import type {
  WslDriveProjectConversionResult,
  WslDriveProjectPreview
} from '../../shared/wsl-drive-project-types'

/** Converting a WSL project on a Windows drive to Windows Git; main gates every call. */
export type WslDriveProjectApi = {
  preview: (projectId: string) => Promise<WslDriveProjectPreview>
  /** Checks again and prepares the repo; the caller saves the returned runtime preference. */
  convert: (request: {
    projectId: string
    alignLineEndings: boolean
  }) => Promise<WslDriveProjectConversionResult>
}

export const wslDriveProjectApi: WslDriveProjectApi = {
  preview: (projectId) => ipcRenderer.invoke('wslDriveProject:preview', projectId),
  convert: (request) => ipcRenderer.invoke('wslDriveProject:convert', request)
}
