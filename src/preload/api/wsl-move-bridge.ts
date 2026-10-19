import { ipcRenderer } from 'electron'
import type {
  WslMovePendingRendererRewrite,
  WslMoveRecordStoreRewrittenRequest,
  WslMoveRecordStoreRewrittenResult
} from '../../shared/wsl-move/wsl-move-renderer-rewrite-types'

/** The renderer half of a committed WSL move's desktop rewrite; main gates both calls. */
export type WslMoveApi = {
  listPendingRendererRewrites: () => Promise<WslMovePendingRendererRewrite[]>
  recordStoreRewritten: (
    request: WslMoveRecordStoreRewrittenRequest
  ) => Promise<WslMoveRecordStoreRewrittenResult>
}

export const wslMoveApi: WslMoveApi = {
  listPendingRendererRewrites: () => ipcRenderer.invoke('wslMove:listPendingRendererRewrites'),
  recordStoreRewritten: (request) => ipcRenderer.invoke('wslMove:recordStoreRewritten', request)
}
