import { randomUUID } from 'node:crypto'
import type { LocalGitExecOptions } from '../../gh-utils'
import { ACTIONS_ARTIFACT_CHUNK_BYTES } from '../../../../shared/github/actions-artifact-types'
const sessions = new Map<
  string,
  { owner: string; archive: Buffer; timer: ReturnType<typeof setTimeout>; dispose: () => void }
>()
/** Bind transfer continuation to the repository path, SSH/WSL host and configured GitHub account. */
export function artifactSessionOwner(
  repoPath: string,
  connectionId?: string | null,
  options: LocalGitExecOptions = {}
): string {
  return JSON.stringify([
    repoPath,
    connectionId ?? null,
    options.wslDistro ?? null,
    options.ghAccount ?? null
  ])
}
/** Release only an owner-matching transfer; repeated cleanup leaves already released sessions untouched. */
export function releaseArtifactSession(transferId: string, owner: string): void {
  const session = sessions.get(transferId)
  if (!session) {
    return
  }
  if (session.owner !== owner) {
    throw new Error('Artifact download owner changed')
  }
  clearTimeout(session.timer)
  sessions.delete(transferId)
  session.dispose()
}
/** Retain archive bytes under the global two-session cap until explicit release, caller loss or five-minute expiry. */
export function createArtifactSession(
  owner: string,
  archive: Buffer,
  fileName: string,
  signal?: AbortSignal,
  onRelease?: () => void
) {
  signal?.throwIfAborted()
  if (sessions.size >= 2) {
    throw new Error('Finish another artifact download before starting a new one')
  }
  const transferId = randomUUID()
  const timer = setTimeout(() => releaseArtifactSession(transferId, owner), 5 * 60_000)
  timer.unref()
  /** Release retained archive bytes immediately when the owning caller disconnects. */
  const abort = () => releaseArtifactSession(transferId, owner)
  sessions.set(transferId, {
    owner,
    archive,
    timer,
    /** Detach the disconnect listener and release the retained caller lifetime when this session ends. */
    dispose: () => {
      signal?.removeEventListener('abort', abort)
      onRelease?.()
    }
  })
  signal?.addEventListener('abort', abort, { once: true })
  return { transferId, sizeBytes: archive.length, fileName }
}
/** Reject foreign or expired transfers and return a bounded chunk at the requested validated byte offset. */
export function readArtifactSession(transferId: string, owner: string, offset: number) {
  const session = sessions.get(transferId)
  if (!session || session.owner !== owner) {
    throw new Error('Artifact download expired or owner changed')
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > session.archive.length) {
    throw new Error('Invalid artifact offset')
  }
  const nextOffset = Math.min(session.archive.length, offset + ACTIONS_ARTIFACT_CHUNK_BYTES)
  return {
    contentBase64: session.archive.subarray(offset, nextOffset).toString('base64'),
    nextOffset,
    done: nextOffset === session.archive.length
  }
}
