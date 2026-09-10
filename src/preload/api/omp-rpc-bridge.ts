import { ipcRenderer } from 'electron'
import type {
  OmpRpcGetCommandsResult,
  OmpRpcRunLocalCommandResult
} from '../../shared/omp-rpc-ipc-contract'
import type { PreloadApi } from '../api-types'

export const ompRpcApi = {
  getCommands: (args: { cwd: string }): Promise<OmpRpcGetCommandsResult> =>
    ipcRenderer.invoke('ompRpc:getCommands', args),
  runLocalCommand: (args: {
    cwd: string
    command: string
  }): Promise<OmpRpcRunLocalCommandResult> => ipcRenderer.invoke('ompRpc:runLocalCommand', args)
} satisfies PreloadApi['ompRpc']
