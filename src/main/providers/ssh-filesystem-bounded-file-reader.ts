import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { isMethodNotFoundError } from '../ssh/ssh-filesystem-stream-reader'
import type { FileChunkReadResult, FileReadResult, TerminalArtifactAccessOptions } from './types'

export async function readSshFileChunk(
  mux: SshChannelMultiplexer,
  filePath: string,
  offset: number,
  length: number
): Promise<FileChunkReadResult> {
  try {
    return (await mux.request('fs.readFileChunk', {
      filePath,
      offset,
      length
    })) as FileChunkReadResult
  } catch (error) {
    if (isMethodNotFoundError(error)) {
      throw new Error('SSH runtime chunked download requires an updated Orca host')
    }
    throw error
  }
}

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
  } catch (error) {
    if (isMethodNotFoundError(error)) {
      throw new Error(
        'Remote terminal artifact access is unavailable. Reconnect the SSH target before retrying.'
      )
    }
    throw error
  }
}

export async function readSshTerminalArtifactChunk(
  mux: SshChannelMultiplexer,
  filePath: string,
  offset: number,
  length: number,
  options: TerminalArtifactAccessOptions
): Promise<FileChunkReadResult> {
  try {
    return (await mux.request('fs.readTerminalArtifactChunk', {
      filePath,
      offset,
      length,
      expectedRealPath: options.expectedRealPath,
      expectedStatIdentity: options.expectedStatIdentity,
      maxBytes: options.maxBytes
    })) as FileChunkReadResult
  } catch (error) {
    if (isMethodNotFoundError(error)) {
      throw new Error(
        'Remote terminal artifact chunks are unavailable. Reconnect the SSH target before retrying.'
      )
    }
    throw error
  }
}
