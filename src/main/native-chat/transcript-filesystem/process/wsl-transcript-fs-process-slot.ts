import type { ChildProcess } from 'node:child_process'
import type {
  WslTranscriptFsProcessRequest,
  WslTranscriptFsProcessResponse
} from './wsl-transcript-fs-process-protocol'

export type SlotDisposition = 'idle' | 'pin' | 'pinned' | 'close'

export type ActiveCall = {
  id: number
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  signal: AbortSignal
  onAbort: () => void
  operation: WslTranscriptFsProcessRequest['operation']
  disposition: SlotDisposition
  handle?: WslTranscriptFsProcessHandle
}

export type WslTranscriptFsProcessHandle = {
  readonly wslTranscriptFsProcessHandle: true
}

export type ProcessSlot = {
  child: ChildProcess
  active: ActiveCall | null
  handles: Set<WslTranscriptFsProcessHandle>
  idleTimer?: ReturnType<typeof setTimeout>
}

export type HandleState = {
  slot: ProcessSlot
  handleId: number
  closePromise?: Promise<void>
}

export type WslTranscriptFsProcessFactory = () => ChildProcess

export const WSL_TRANSCRIPT_FS_PROCESS_CLOSE_TIMEOUT_MS = 30_000
// Reap idle Electron children to release RSS; outlast the close deadline so pending closes retain their slot.
export const WSL_TRANSCRIPT_FS_PROCESS_IDLE_REAP_MS = 60_000

export function attachSlotChild(
  child: ChildProcess,
  handlers: {
    onResponse: (response: WslTranscriptFsProcessResponse) => void
    onFault: (error: Error) => void
  }
): ProcessSlot {
  const slot: ProcessSlot = { child, active: null, handles: new Set() }
  child.on('message', (response: WslTranscriptFsProcessResponse) => handlers.onResponse(response))
  child.on('error', (error) => handlers.onFault(error))
  child.on('disconnect', () => handlers.onFault(new Error('WSL filesystem process disconnected')))
  child.on('exit', (code, signal) =>
    handlers.onFault(new Error(`WSL filesystem process exited (${signal ?? code})`))
  )
  // Neither child nor IPC may keep parent shutdown alive.
  child.unref()
  child.channel?.unref?.()
  return slot
}
