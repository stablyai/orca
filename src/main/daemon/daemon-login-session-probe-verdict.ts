import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'

export const MAX_DAEMON_LOGIN_SESSION_PROBE_BYTES = 64

export function readDaemonLoginSessionProbeVerdict(filePath: string): string {
  try {
    return readNodeFileSyncWithinLimit(filePath, MAX_DAEMON_LOGIN_SESSION_PROBE_BYTES)
      .buffer.toString('utf8')
      .trim()
  } catch {
    return ''
  }
}
