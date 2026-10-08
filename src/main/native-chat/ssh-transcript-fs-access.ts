import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { readRemoteTranscriptRange } from '../runtime/orchestration/worker-transcript-remote-range-read'
import type { SshTranscriptLocation } from './ssh-transcript-path'

export type SshTranscriptHandle = { sshTranscript: SshTranscriptLocation }

// Why: the provider is looked up per call, so a reconnect is picked up and a disconnect throws
// instead of reading anything on this machine.
export async function statSshTranscript(location: SshTranscriptLocation) {
  const stat = await requireSshFilesystemProvider(location.connectionId).stat(location.remotePath)
  const mtimeMs = stat.mtimeMs ?? stat.mtime
  return { size: stat.size, mtimeMs, ctimeMs: mtimeMs, dev: stat.dev ?? 0, ino: stat.ino ?? 0 }
}

export async function readSshTranscript(
  handle: SshTranscriptHandle,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number
): Promise<{ bytesRead: number; buffer: Buffer }> {
  const { connectionId, remotePath } = handle.sshTranscript
  const bytes = await readRemoteTranscriptRange(
    requireSshFilesystemProvider(connectionId),
    remotePath,
    position,
    length
  )
  buffer.set(bytes, offset)
  return { bytesRead: bytes.length, buffer }
}
