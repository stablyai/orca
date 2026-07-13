/* Symbol-index preload bindings — split out of `src/preload/index.ts` following
   the same pattern as `./gitlab`, so adding or changing a `symbolIndex.*`
   channel doesn't surface as a merge conflict on every upstream sync of the
   much larger central preload file. Composed back into `api.symbolIndex` from
   `index.ts`. */
import { ipcRenderer } from 'electron'
import {
  SYMBOL_INDEX_IPC,
  type FindDefinitionsRequest,
  type FindDefinitionsResponse
} from '../shared/symbol-index'

export const symbolIndex = {
  findDefinitions: (req: FindDefinitionsRequest): Promise<FindDefinitionsResponse> =>
    ipcRenderer.invoke(SYMBOL_INDEX_IPC.findDefinitions, req),
  ensureIndexed: (args: { worktreeId: string; worktreeRoot: string }): Promise<void> =>
    ipcRenderer.invoke(SYMBOL_INDEX_IPC.ensureIndexed, args)
}
