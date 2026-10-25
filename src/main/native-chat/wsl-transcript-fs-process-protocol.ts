export type WslTranscriptFsProcessCall =
  | { operation: 'access'; path: string }
  | { operation: 'stat' | 'lstat' | 'readdir'; path: string }
  // Keep open separate so Exclude removes its whole union member.
  | { operation: 'open'; path: string }
  | { operation: 'readfile'; path: string; encoding: BufferEncoding }
  | { operation: 'read'; handleId: number; position: number; length: number }
  | { operation: 'close'; handleId: number }

export type WslTranscriptFsProcessRequest = WslTranscriptFsProcessCall & { id: number }

/** Handles pin a process; only other calls may reuse pooled children. */
export type WslTranscriptFsReusableProcessCall = Exclude<
  WslTranscriptFsProcessCall,
  { operation: 'open' | 'read' | 'close' }
>

export type WslTranscriptFsDirent = {
  name: string
  parentPath: string
  isBlockDevice: boolean
  isCharacterDevice: boolean
  isDirectory: boolean
  isFIFO: boolean
  isFile: boolean
  isSocket: boolean
  isSymbolicLink: boolean
}

export type WslTranscriptFsProcessError = {
  name: string
  message: string
  code?: string
  errno?: number
  syscall?: string
  path?: string
}

export type WslTranscriptFsProcessResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: WslTranscriptFsProcessError }

export function invalidTranscriptHandleError(): NodeJS.ErrnoException {
  return Object.assign(new Error('WSL transcript file handle is no longer available'), {
    code: 'EBADF'
  })
}
