import type { RuntimeWorktreeScanAttempt } from './repo-worktree-resolution-scan'
import type { WitnessedRuntimeWorktreeScan } from './runtime-witnessed-worktree-scan'
import type { captureGitWorktreeObservationCommit } from '../../../workspaces/catalog/git-worktree-observations'

export type RuntimeWorktreeScanCache = {
  generation: number
  runtimeKey: string
  result: RuntimeWorktreeScanAttempt
  listing?: WitnessedRuntimeWorktreeScan
  expiresAt: number
  adminFingerprint: string | null
  scannedAt: number
}

export type RuntimeWorktreeScanInFlight = {
  generation: number
  runtimeKey: string
  promise: Promise<RuntimeWorktreeScanRefresh>
}

export type RuntimeWorktreeScanRefresh = {
  observationCommit?: ReturnType<typeof captureGitWorktreeObservationCommit>
  result: RuntimeWorktreeScanAttempt
  adminFingerprint: string | null
  adminFingerprintProbe: Promise<string | null> | null
  scannedAt: number
}
