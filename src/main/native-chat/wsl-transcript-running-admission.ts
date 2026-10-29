import { blockedWslDistroForPath } from '../wsl/wsl-unc-access-gate'
import { wslTranscriptFsDistroNotRunningError } from './wsl-transcript-fs-error'

/**
 * Nothing tells a transcript reader (main or the session scanner process) that a distro stopped,
 * so a running read is trusted only this long: about one `wsl --list --running` per 5 s of reads.
 */
export const WSL_TRANSCRIPT_RUNNING_LEASE_MS = 5_000

/**
 * Any 9P touch of `\\wsl.localhost\<distro>`, or a `wsl.exe --exec` there, boots a stopped distro.
 * Transcript reads are background work, so they refuse unless it runs (E9); a user act passes.
 */
export async function admitWslTranscriptPath(path: string): Promise<void> {
  const blocked = await blockedWslDistroForPath(path, null, {
    leaseMs: WSL_TRANSCRIPT_RUNNING_LEASE_MS
  })
  if (blocked) {
    throw wslTranscriptFsDistroNotRunningError(blocked.distro, blocked.state)
  }
}
