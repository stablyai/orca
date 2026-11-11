import { wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { scanIssueTextFromError } from './session-scan-issues'
import type { AiVaultScanIssue } from '../../shared/ai-vault/contracts/ai-vault-types'
import type { FileWithMtime } from './session-scanner-types'
import type { SessionSidecarObservation } from './parse-cache/session-sidecar-stat'

export type SessionFileObservation =
  | { file: Omit<FileWithMtime, 'modifiedAt'>; sidecarPath?: string }
  | { issue: Omit<AiVaultScanIssue, 'agent' | 'kind' | 'executionHostId'>; missing?: boolean }

export async function observeSessionFile(
  path: string,
  contentDependencyPath?: (
    path: string,
    signal?: AbortSignal
  ) => string | undefined | Promise<string | undefined>,
  signal?: AbortSignal,
  knownDependency?: { file: FileWithMtime; path?: string }
): Promise<SessionFileObservation> {
  try {
    const fileStat = await wslGatedStat(path, 'scan', signal)
    const previous = knownDependency?.file
    const unchanged =
      previous &&
      previous.mtimeMs === fileStat.mtimeMs &&
      previous.sizeBytes === fileStat.size &&
      previous.dev === fileStat.dev &&
      previous.ino === fileStat.ino
    const sidecarPath =
      unchanged && knownDependency.path
        ? knownDependency.path
        : contentDependencyPath
          ? await contentDependencyPath(path, signal)
          : undefined
    const sidecar = sidecarPath ? await observeSessionSidecar(sidecarPath, signal) : 'none'
    return {
      file: {
        path,
        mtimeMs: fileStat.mtimeMs,
        sizeBytes: fileStat.size,
        sidecar,
        dev: fileStat.dev,
        ino: fileStat.ino,
        nlink: fileStat.nlink
      },
      sidecarPath
    }
  } catch (err) {
    return {
      issue: { path, ...scanIssueTextFromError(err) },
      missing: isMissingTranscriptPathError(err)
    }
  }
}

/** Only missing sidecars are none; other stat failures stay unknown so cached enrichment can retry. */
async function observeSessionSidecar(
  filePath: string | undefined,
  signal?: AbortSignal
): Promise<SessionSidecarObservation> {
  if (!filePath) {
    return 'none'
  }
  try {
    const fileStat = await wslGatedStat(filePath, 'scan', signal)
    return {
      path: filePath,
      mtimeMs: fileStat.mtimeMs,
      sizeBytes: fileStat.size
    }
  } catch (error) {
    return isMissingTranscriptPathError(error) ? 'none' : 'unknown'
  }
}

/** A missing file or folder is absence, not a refusal; WSL gate errors are always refusals. */
export function isMissingTranscriptPathError(error: unknown): boolean {
  if (error instanceof WslTranscriptFsError) {
    return false
  }
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export function retainRecentSessionFile(
  recent: Map<string, FileWithMtime>,
  file: FileWithMtime,
  limit: number
): void {
  recent.delete(file.path)
  recent.set(file.path, file)
  if (recent.size <= limit) {
    return
  }
  let oldest: FileWithMtime | undefined
  for (const candidate of recent.values()) {
    if (!oldest || candidate.mtimeMs < oldest.mtimeMs) {
      oldest = candidate
    }
  }
  if (oldest) {
    recent.delete(oldest.path)
  }
}
