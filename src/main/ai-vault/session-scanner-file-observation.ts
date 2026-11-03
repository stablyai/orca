import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { scanIssueTextFromError } from './session-scan-issues'
import type { FileWithMtime } from './session-scanner-types'
import type { SessionSidecarObservation } from './session-sidecar-stat'

export type SessionFileObservation =
  | { file: Omit<FileWithMtime, 'modifiedAt'>; sidecarPath?: string }
  | { issue: Omit<AiVaultScanIssue, 'agent' | 'kind' | 'executionHostId'> }

export async function observeSessionFile(
  path: string,
  contentDependencyPath?: (path: string) => string | undefined | Promise<string | undefined>,
  contentFingerprint?: (path: string, signal?: AbortSignal) => Promise<string>,
  signal?: AbortSignal
): Promise<SessionFileObservation> {
  try {
    const fileStat = await wslGatedStat(path, 'scan', signal)
    const fingerprint = contentFingerprint ? await contentFingerprint(path, signal) : undefined
    const sidecarPath = contentDependencyPath ? await contentDependencyPath(path) : undefined
    const sidecar = sidecarPath ? await observeSessionSidecar(sidecarPath, signal) : 'none'
    return {
      file: {
        path,
        mtimeMs: fileStat.mtimeMs,
        sizeBytes: fileStat.size,
        ...(fingerprint === undefined ? {} : { contentFingerprint: fingerprint }),
        sidecar,
        dev: fileStat.dev,
        ino: fileStat.ino,
        nlink: fileStat.nlink
      },
      sidecarPath
    }
  } catch (error) {
    return { issue: { path, ...scanIssueTextFromError(error) } }
  }
}

async function observeSessionSidecar(
  filePath: string,
  signal?: AbortSignal
): Promise<SessionSidecarObservation> {
  try {
    const fileStat = await wslGatedStat(filePath, 'scan', signal)
    return { path: filePath, mtimeMs: fileStat.mtimeMs, sizeBytes: fileStat.size }
  } catch (error) {
    return isMissingSidecarError(error) ? 'none' : 'unknown'
  }
}

export function isMissingSidecarError(error: unknown): boolean {
  if (error instanceof WslTranscriptFsError) {
    return false
  }
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null
  return code === 'ENOENT' || code === 'ENOTDIR'
}
