import type { AiVaultScanIssue } from '../../../shared/ai-vault/contracts/ai-vault-types'
import { wslGatedStat } from '../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import type { SessionSidecarObservation } from '../parse-cache/session-sidecar-stat'
import { scanIssueTextFromError } from '../parsing/session-scan-issues'
import { throwIfAiVaultScanCancelled } from '../scan-lifecycle/ai-vault-scan-cancellation'
import type { SessionDiscoveredFile } from './session-discovery-stat-cache'
import { isMissingTranscriptPathError } from './session-path-absence'

export type SessionFileObservation =
  | SessionDiscoveredFile
  | { issue: Omit<AiVaultScanIssue, 'agent' | 'kind' | 'executionHostId'> }

export async function directoryMtime(path: string, signal?: AbortSignal): Promise<number | null> {
  try {
    return (await wslGatedStat(path, 'scan', signal)).mtimeMs
  } catch {
    throwIfAiVaultScanCancelled(signal)
    return null
  }
}

export async function observeSessionFile(
  path: string,
  contentDependencyPath?: (path: string) => string | undefined | Promise<string | undefined>,
  signal?: AbortSignal
): Promise<SessionFileObservation> {
  try {
    const fileStat = await wslGatedStat(path, 'scan', signal)
    const sidecarPath = contentDependencyPath ? await contentDependencyPath(path) : undefined
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
    return { issue: { path, ...scanIssueTextFromError(err) } }
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
