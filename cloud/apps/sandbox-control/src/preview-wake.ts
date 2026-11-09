// Preview-URL wake semantics. W3's share gateway (share-pages.ts) owns the "asleep — Wake workspace"
// page and viewer auth; its `__orca/wake` handler calls this so every preview wake goes through the
// same single-flight, entitlement-checked wake as open/message/SSH (workspace-lifecycle.ts).
// Archived workspaces are never revived by a preview link (state 'archived' → the gateway's "gone").
import type { LifecycleDeps } from './lifecycle'
import type { SandboxRow } from './store'
import { wakeSandbox, type WakeAnswer, type WorkspaceConfig } from './workspace-lifecycle'

/** Default no wait: the page polls status itself; pass `waitMs` (≤30 s) to long-poll instead. */
export function wakeForPreview(
  deps: LifecycleDeps,
  row: SandboxRow,
  config: WorkspaceConfig & { waitMs?: number } = {}
): Promise<WakeAnswer> {
  return wakeSandbox(deps, row, { ...config, waitMs: config.waitMs ?? 0 })
}
