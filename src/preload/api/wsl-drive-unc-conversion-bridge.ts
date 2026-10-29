import { ipcRenderer } from 'electron'
import type {
  WslDriveUncConversionRequest,
  WslDriveUncConversionResult
} from '../../shared/wsl-drive-unc-conversion-types'
import type { WslDriveUncPendingRendererRewrite } from '../../shared/wsl-drive-unc-renderer-store-keys'
import type { WslMoveRecordStoreRewrittenResult } from '../../shared/wsl-move/wsl-move-renderer-rewrite-types'

/** Converting a UNC Windows-drive project to its drive path; main gates every call. */
export type WslDriveUncConversionApi = {
  /** Checks, pauses the project's terminals and restarts the app to convert. */
  convert: (request: WslDriveUncConversionRequest) => Promise<WslDriveUncConversionResult>
  listPendingRendererRewrites: () => Promise<WslDriveUncPendingRendererRewrite[]>
  recordStoreRewritten: (request: {
    migrationId: string
    storeId: string
  }) => Promise<WslMoveRecordStoreRewrittenResult>
}

export const wslDriveUncConversionApi: WslDriveUncConversionApi = {
  convert: (request) => ipcRenderer.invoke('wslDriveUnc:convert', request),
  listPendingRendererRewrites: () => ipcRenderer.invoke('wslDriveUnc:listPendingRendererRewrites'),
  recordStoreRewritten: (request) => ipcRenderer.invoke('wslDriveUnc:recordStoreRewritten', request)
}
