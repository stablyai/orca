import { ipcRenderer } from 'electron'
import type {
  TerminalModelCheckpointLease,
  TerminalModelCheckpointResourceWindow,
  TerminalModelCheckpointTransport
} from '../../shared/terminal-model-checkpoint-lease'

export const ptyModelCheckpointApi = {
  captureModelCheckpoint: (
    id: string,
    expectedIncarnationId: string
  ): Promise<TerminalModelCheckpointLease | null> =>
    ipcRenderer.invoke('pty:captureModelCheckpoint', { id, expectedIncarnationId }),
  readModelCheckpoint: (
    id: string,
    window: TerminalModelCheckpointResourceWindow
  ): Promise<Uint8Array> => ipcRenderer.invoke('pty:readModelCheckpoint', { id, ...window }),
  releaseModelCheckpoint: (id: string, leaseId: string): Promise<boolean> =>
    ipcRenderer.invoke('pty:releaseModelCheckpoint', { id, leaseId })
} satisfies TerminalModelCheckpointTransport
