import type { Writable } from 'node:stream'
import { ProviderStdioWriteQueue } from '../provider-process/provider-stdio-write-queue'
import { AcpConnectionClosedError } from './acp-errors'

export class AcpWriteQueue extends ProviderStdioWriteQueue {
  constructor(output: Writable, maxBytes: number, onFailure: (error: Error) => void) {
    super(output, maxBytes, onFailure, {
      capacity: () => new Error('ACP write queue capacity exceeded'),
      closed: () => new AcpConnectionClosedError('ACP output is not writable')
    })
  }
}
