import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { isMethodNotFoundError, readFileViaStream } from '../ssh/ssh-filesystem-stream-reader'
import type { FileReadLimits, FileReadResult } from './types'

export class SshFilesystemFileReader {
  private loggedStreamFallback = false

  constructor(private readonly mux: SshChannelMultiplexer) {}

  async readFile(filePath: string, limits?: FileReadLimits): Promise<FileReadResult> {
    try {
      return await readFileViaStream(this.mux, filePath, limits)
    } catch (error) {
      if (!isMethodNotFoundError(error)) {
        throw error
      }
      if (!this.loggedStreamFallback) {
        this.loggedStreamFallback = true
        console.warn(
          '[ssh-fs] Relay does not implement fs.readFileStream; falling back to fs.readFile (10 MB cap)'
        )
      }
      return (await this.mux.request('fs.readFile', { filePath })) as FileReadResult
    }
  }
}
