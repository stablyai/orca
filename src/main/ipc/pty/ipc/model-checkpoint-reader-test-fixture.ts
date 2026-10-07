import { terminalModelCheckpointLeaseSchema } from '../../../../shared/terminal-model-checkpoint-reader'
import type { TerminalModelCheckpointTransport } from '../../../../shared/terminal-model-checkpoint-lease'
import { invoke } from './model-checkpoint-test-fixture'

export const transport: TerminalModelCheckpointTransport = {
  captureModelCheckpoint: async (id, expectedIncarnationId) => {
    const response = await invoke('captureModelCheckpoint', { id, expectedIncarnationId })
    return response === null ? null : terminalModelCheckpointLeaseSchema.parse(response)
  },
  readModelCheckpoint: async (id, window) => {
    const response = await invoke('readModelCheckpoint', { id, ...window })
    if (!(response instanceof Uint8Array)) {
      throw new Error('Expected owned IPC checkpoint bytes')
    }
    return response
  },
  releaseModelCheckpoint: async (id, leaseId) => {
    const response = await invoke('releaseModelCheckpoint', { id, leaseId })
    if (typeof response !== 'boolean') {
      throw new Error('Expected IPC checkpoint release result')
    }
    return response
  }
}
