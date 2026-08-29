import type {
  WorkspaceCleanupCandidate,
  WorkspaceCleanupScanError,
  WorkspaceCleanupScanProgress
} from '../../shared/workspace-cleanup'
import { appendWorkspaceCleanupItems } from './workspace-cleanup-scan-primitives'

const WORKSPACE_CLEANUP_PROGRESS_EMIT_INTERVAL_MS = 100

export type WorkspaceCleanupScanOptions = {
  onProgress?: (progress: WorkspaceCleanupScanProgress) => void
  signal?: AbortSignal
}

export type WorkspaceCleanupProgressEmitter = {
  addDiscovered: (count: number) => void
  addCandidate: (candidate: WorkspaceCleanupCandidate) => void
  addErrors: (errors: WorkspaceCleanupScanError[]) => void
  flush: () => void
}

/** Caps renderer projection churn while preserving an immediate final progress state. */
export function createWorkspaceCleanupProgressEmitter(
  scanId: string | undefined,
  scannedAt: number,
  options: WorkspaceCleanupScanOptions
): WorkspaceCleanupProgressEmitter {
  const errors: WorkspaceCleanupScanError[] = []
  let pendingCandidates: WorkspaceCleanupCandidate[] = []
  let totalWorktreeCount = 0
  let scannedWorktreeCount = 0
  let dirty = false
  let emittedInitialDiscovery = false
  let timer: NodeJS.Timeout | null = null
  const flush = (): void => {
    if (!scanId || !dirty) {
      return
    }
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    dirty = false
    const candidates = pendingCandidates
    pendingCandidates = []
    options.onProgress?.({
      scanId,
      scannedAt,
      totalWorktreeCount,
      scannedWorktreeCount,
      candidates,
      errors: [...errors],
      candidateMode: 'append'
    })
  }
  const schedule = (): void => {
    if (!scanId) {
      return
    }
    dirty = true
    timer ??= setTimeout(flush, WORKSPACE_CLEANUP_PROGRESS_EMIT_INTERVAL_MS)
  }
  return {
    addDiscovered: (count) => {
      totalWorktreeCount += count
      schedule()
      if (!emittedInitialDiscovery) {
        emittedInitialDiscovery = true
        flush()
      }
    },
    addCandidate: (candidate) => {
      pendingCandidates.push(candidate)
      scannedWorktreeCount += 1
      schedule()
    },
    addErrors: (newErrors) => {
      appendWorkspaceCleanupItems(errors, newErrors)
      schedule()
    },
    flush
  }
}
