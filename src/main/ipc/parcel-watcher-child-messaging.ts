import type { ChildProcess } from 'node:child_process'
import type { HostToWatcherMessage } from './parcel-watcher-process-protocol'

export function sendToWatcherChild(proc: ChildProcess, message: HostToWatcherMessage): void {
  try {
    proc.send(message)
  } catch {
    // The child's exit handler owns recovery after its IPC channel closes.
  }
}
