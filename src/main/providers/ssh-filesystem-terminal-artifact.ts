import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { isMethodNotFoundError } from '../ssh/ssh-filesystem-stream-reader'
import type { FileReadResult, FileStat, TerminalArtifactAccessOptions } from './types'

export async function readSshTerminalArtifact(
  mux: SshChannelMultiplexer,
  filePath: string,
  options: TerminalArtifactAccessOptions
): Promise<FileReadResult> {
  try {
    return (await mux.request('fs.readTerminalArtifact', {
      filePath,
      expectedRealPath: options.expectedRealPath,
      expectedStatIdentity: options.expectedStatIdentity,
      maxBytes: options.maxBytes
    })) as FileReadResult
  } catch (err) {
    if (isMethodNotFoundError(err)) {
      throw new Error(
        'Remote terminal artifact access is unavailable. Reconnect the SSH target before retrying.'
      )
    }
    throw err
  }
}

export async function writeSshTerminalArtifact(
  mux: SshChannelMultiplexer,
  filePath: string,
  content: string,
  options: TerminalArtifactAccessOptions
): Promise<FileStat> {
  let result: { stat?: FileStat }
  try {
    result = (await mux.request('fs.writeTerminalArtifact', {
      filePath,
      content,
      expectedRealPath: options.expectedRealPath,
      expectedStatIdentity: options.expectedStatIdentity,
      maxBytes: options.maxBytes
    })) as { stat?: FileStat }
  } catch (err) {
    if (isMethodNotFoundError(err)) {
      throw new Error(
        'Remote terminal artifact access is unavailable. Reconnect the SSH target before retrying.'
      )
    }
    throw err
  }
  if (!result.stat) {
    throw new Error('terminal_file_grant_stale')
  }
  return result.stat
}
