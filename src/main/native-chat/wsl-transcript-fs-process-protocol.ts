export type WslTranscriptFsProcessCall =
  | { operation: 'access'; path: string }
  | { operation: 'stat' | 'lstat' | 'readdir'; path: string }
  // Kept as its own member so the reusable-call Exclude below can strip it:
  // Exclude compares whole union members, not individual operation literals.
  | { operation: 'open'; path: string }
  | { operation: 'readfile'; path: string; encoding: BufferEncoding }
  | { operation: 'read'; handleId: number; position: number; length: number }
  | { operation: 'close'; handleId: number }

// The intersection distributes over the union, so `{ ...call, id }` composes
// a request without casts at the IPC boundary.
export type WslTranscriptFsProcessRequest = WslTranscriptFsProcessCall & { id: number }

/** Calls a pooled process may serve; open/read/close manage a pinned handle. */
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

/** The owning process, client, or entry no longer knows this handle. */
export function invalidTranscriptHandleError(): NodeJS.ErrnoException {
  return Object.assign(new Error('WSL transcript file handle is no longer available'), {
    code: 'EBADF'
  })
}
