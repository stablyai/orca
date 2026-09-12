import { ipcRenderer } from 'electron'
import {
  SYMBOL_INDEX_IPC,
  type FindDefinitionsRequest,
  type FindDefinitionsResponse
} from '../../shared/symbol-index'
import type { PreloadApi } from '../api-types'

export const symbolIndexApi = {
  findDefinitions: (req: FindDefinitionsRequest): Promise<FindDefinitionsResponse> =>
    ipcRenderer.invoke(SYMBOL_INDEX_IPC.findDefinitions, req),
  ensureIndexed: (args: { worktreeId: string; worktreeRoot: string }): Promise<void> =>
    ipcRenderer.invoke(SYMBOL_INDEX_IPC.ensureIndexed, args)
} satisfies PreloadApi['symbolIndex']
