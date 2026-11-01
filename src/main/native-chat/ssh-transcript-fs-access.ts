import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import type { SshTranscriptLocation } from './ssh-transcript-path'

export type SshTranscriptHandle = { sshTranscript: SshTranscriptLocation }

// This process serves no SSH filesystem; refuse rather than probe the local machine.
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
