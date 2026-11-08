import { open, type FileHandle } from 'node:fs/promises'
import { isWslUncPath } from '../../shared/wsl-paths'
import {
  closeTranscriptHandle,
  openTranscriptFile,
  readTranscriptFile,
  type TranscriptFileHandle
} from '../native-chat/wsl-transcript-fs-access'
import { transcriptHandleSnapshot } from '../native-chat/wsl-transcript-handle-snapshot'
import type { WslTranscriptFileSnapshot } from '../native-chat/wsl-transcript-fs-process-protocol'

export class WslJsonlFileHandle {
  constructor(
    private readonly path: string,
    private readonly handle: TranscriptFileHandle
  ) {}

  snapshot(): Promise<WslTranscriptFileSnapshot> {
    return transcriptHandleSnapshot(this.handle, this.path)
  }

  read(buffer: Buffer, offset: number, length: number, position: number) {
    return readTranscriptFile(this.handle, this.path, buffer, offset, length, position, 'scan')
  }

  close(): Promise<void> {
    return closeTranscriptHandle(this.handle, this.path)
  }
}

export type JsonlFileHandle = FileHandle | WslJsonlFileHandle

export async function openJsonlFileHandle(path: string): Promise<JsonlFileHandle> {
  return isWslUncPath(path)
    ? new WslJsonlFileHandle(path, await openTranscriptFile(path, 'scan'))
    : open(path, 'r')
}
