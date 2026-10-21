import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import type { SshTranscriptLocation } from './ssh-transcript-path'

export type SshTranscriptHandle = { sshTranscript: SshTranscriptLocation }

// Why: this process serves no SSH filesystem, so an SSH transcript throws instead of reading
// anything on this machine.
export async function statSshTranscript(location: SshTranscriptLocation): Promise<{
  size: number
  mtimeMs: number
  ctimeMs: number
  dev: number
  ino: number
}> {
  throw new SshHostNotServedError(location.connectionId)
}

export async function readSshTranscript(
  handle: SshTranscriptHandle
): Promise<{ bytesRead: number; buffer: Buffer }> {
  throw new SshHostNotServedError(handle.sshTranscript.connectionId)
}
