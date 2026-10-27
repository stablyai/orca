import type { IPty } from 'node-pty'
import { readPtyRootCreationTimeMs } from '../../windows/windows-pty-job'

/** Capture from the owned native handle; a later PID lookup can identify a replacement. */
export function captureSpawnedRootCreationTimeMs(proc: IPty): number | undefined {
  if (process.platform !== 'win32' || !Number.isInteger(proc.pid) || proc.pid <= 0) {
    return undefined
  }
  return readPtyRootCreationTimeMs(proc)
}
