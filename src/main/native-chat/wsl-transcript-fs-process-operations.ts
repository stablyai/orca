import { access, lstat, open, readdir, readFile, stat, type FileHandle } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import {
  invalidTranscriptHandleError,
  type WslTranscriptFsDirent,
  type WslTranscriptFsProcessRequest
} from './wsl-transcript-fs-process-protocol'

function serializeDirent(entry: Dirent): WslTranscriptFsDirent {
  return {
    name: entry.name,
    parentPath: entry.parentPath,
    isBlockDevice: entry.isBlockDevice(),
    isCharacterDevice: entry.isCharacterDevice(),
    isDirectory: entry.isDirectory(),
    isFIFO: entry.isFIFO(),
    isFile: entry.isFile(),
    isSocket: entry.isSocket(),
    isSymbolicLink: entry.isSymbolicLink()
  }
}

export class WslTranscriptFsProcessOperations {
  private readonly handles = new Map<number, FileHandle>()
  private nextHandleId = 1

  async execute(request: WslTranscriptFsProcessRequest): Promise<unknown> {
    switch (request.operation) {
      case 'access':
        await access(request.path)
        return true
      case 'stat':
        return stat(request.path)
      case 'lstat':
        return lstat(request.path)
      case 'readdir':
        return (await readdir(request.path, { withFileTypes: true })).map(serializeDirent)
      case 'readfile':
        return readFile(request.path, request.encoding)
      case 'open': {
        const handle = await open(request.path, 'r')
        const handleId = this.nextHandleId++
        this.handles.set(handleId, handle)
        return handleId
      }
      case 'read': {
        const handle = this.handles.get(request.handleId)
        if (!handle) {
          throw invalidTranscriptHandleError()
        }
        const buffer = Buffer.allocUnsafe(request.length)
        const { bytesRead } = await handle.read(buffer, 0, request.length, request.position)
        return buffer.subarray(0, bytesRead)
      }
      case 'close': {
        const handle = this.handles.get(request.handleId)
        this.handles.delete(request.handleId)
        await handle?.close()
        return true
      }
    }
  }
}
