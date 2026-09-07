import type { BrowserWindow } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import type { OrcaRuntimeService, RuntimeWorktreeLifecycleEvent } from '../../runtime/orca-runtime'
import type { SenderScopedRequestCancellations } from '../sender-scoped-request-cancellation'
import type { WorktreeRemovalInFlight } from './removal/worktree-removal-coordinator'

export type WorktreeIpcContext = {
  mainWindow: BrowserWindow
  store: Store
  runtime: OrcaRuntimeService
  options?: {
    onWorktreeLifecycle?: (event: RuntimeWorktreeLifecycleEvent) => void
  }
  detectedWorktreeCancellations: SenderScopedRequestCancellations
  worktreeRemovalsInFlight: Map<string, WorktreeRemovalInFlight>
}

// Why: removal and forget both delete refs, and a ref deletion has to take the
// `packed-refs` lock. Idle ref maintenance needs a process-wide view of that
// registry so it never packs while one is running.
let activeWorktreeRemovals: ReadonlyMap<string, WorktreeRemovalInFlight> | null = null

export function createWorktreeRemovalRegistry(): Map<string, WorktreeRemovalInFlight> {
  const registry = new Map<string, WorktreeRemovalInFlight>()
  activeWorktreeRemovals = registry
  return registry
}

export function hasWorktreeRemovalsInFlight(): boolean {
  return (activeWorktreeRemovals?.size ?? 0) > 0
}
