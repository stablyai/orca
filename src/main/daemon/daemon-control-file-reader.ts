import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'

export const MAX_DAEMON_CONTROL_FILE_BYTES = 64 * 1024

export function readDaemonControlFileText(filePath: string): string {
  return readNodeFileSyncWithinLimit(filePath, MAX_DAEMON_CONTROL_FILE_BYTES).buffer.toString(
    'utf8'
  )
}
