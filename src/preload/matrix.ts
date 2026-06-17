/* Matrix preload bindings — split out of `src/preload/index.ts` so adding or
   changing a `matrix:*` channel doesn't surface as a merge conflict on every
   upstream sync of the much larger central preload file. Composed back into
   `api.matrix` from `index.ts`. */
import { ipcRenderer } from 'electron'
// Why: preload must not import from `src/main/*` (it runs in the renderer's
// isolated world). The renderer-facing shapes live in shared/ so this wrapper,
// PreloadApi, and the settings pane all type against one contract.
import type { MatrixConnectionStatus, MatrixOutboundResult } from '../shared/matrix-adapter-types'

export const matrixApi = {
  status: (): Promise<MatrixConnectionStatus> => ipcRenderer.invoke('matrix:status'),

  connect: (args: { token: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('matrix:connect', args),

  disconnect: (): Promise<void> => ipcRenderer.invoke('matrix:disconnect'),

  sendTest: (args: { message: string }): Promise<MatrixOutboundResult> =>
    ipcRenderer.invoke('matrix:sendTest', args)
}
