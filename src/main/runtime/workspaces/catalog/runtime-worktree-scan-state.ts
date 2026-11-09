import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'

export type RuntimeWorktreeScanCache = {
  generation: number
  runtimeKey: string
  result: RuntimeWorktreeScanResult
  listing?: RuntimeWorktreeScanResult
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
  result: RuntimeWorktreeScanResult
  adminFingerprint: string | null
  adminFingerprintProbe: Promise<string | null> | null
  scannedAt: number
}
