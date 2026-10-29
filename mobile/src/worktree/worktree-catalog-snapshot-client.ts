import type { RpcClient } from '../transport/rpc-client'
import type { Worktree } from './workspace-list-sections'
import { worktreeCatalogRead } from './worktree-catalog-operations'

// Why: worktree.ps silently truncates at 200; use a high cap so large hosts don't drop workspaces.
export const WORKTREE_PS_FULL_LIMIT = 10_000

export type WorktreeCatalogAdmission<T> =
  | { kind: 'full'; snapshotId: string | null; worktrees: T[] }
  | { kind: 'unchanged'; snapshotId: string }
  | { kind: 'invalid' }

export type PendingWorktreeCatalog = {
  admission: WorktreeCatalogAdmission<Worktree>
  client: RpcClient
  hostId: string
}

// Keep fetch failure distinct from an empty host catalog (STA-3123).
export type WorktreeCatalogFetchResult =
  | { kind: 'response'; pending: PendingWorktreeCatalog }
  | { kind: 'request_failed'; code: string }

function validSnapshotId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null
}

export function admitWorktreeCatalogResponse<T>(
  result: unknown,
  requestedSnapshotId: string | null
): WorktreeCatalogAdmission<T> {
  if (!result || typeof result !== 'object') {
    return { kind: 'invalid' }
  }
  const response = result as {
    snapshotId?: unknown
    unchanged?: unknown
    worktrees?: unknown
  }
  // Rows identify a full response; a future unchanged field must not reclassify one.
  if (Array.isArray(response.worktrees)) {
    return {
      kind: 'full',
      snapshotId: validSnapshotId(response.snapshotId),
      worktrees: response.worktrees as T[]
    }
  }

  const snapshotId = validSnapshotId(response.snapshotId)
  if (response.unchanged === true && snapshotId && snapshotId === requestedSnapshotId) {
    return { kind: 'unchanged', snapshotId }
  }
  return { kind: 'invalid' }
}

export class WorktreeCatalogSnapshotClient {
  private client: RpcClient | null = null
  private hostId: string | null = null
  private snapshotId: string | null = null
  private confirmedWorktrees: Worktree[] | null = null

  async fetch(client: RpcClient, hostId: string): Promise<WorktreeCatalogFetchResult> {
    if (this.client !== client || this.hostId !== hostId) {
      this.client = client
      this.hostId = hostId
      this.snapshotId = null
      this.confirmedWorktrees = null
    }
    const requestedSnapshotId = this.snapshotId
    const reply = await worktreeCatalogRead.request(client, {
      limit: WORKTREE_PS_FULL_LIMIT,
      afterSnapshotId: requestedSnapshotId
    })
    const catalog = worktreeCatalogRead.interpret(reply)
    if (!catalog.accepted) {
      // The refusal code the caller reports lives on the envelope; no acceptance policy carries it.
      const code = reply.ok ? undefined : reply.error?.code
      return {
        kind: 'request_failed',
        code: typeof code === 'string' && code.length > 0 ? code : 'request_failed'
      }
    }
    return {
      kind: 'response',
      pending: {
        admission: admitWorktreeCatalogResponse<Worktree>(catalog.value, requestedSnapshotId),
        client,
        hostId
      }
    }
  }

  /** The confirmed host catalog to apply, or null when there is nothing to apply. */
  admit(pending: PendingWorktreeCatalog | null): Worktree[] | null {
    if (!pending) {
      return null
    }
    // Discard stale client/host replies without invalidating the current session’s token.
    if (pending.client !== this.client || pending.hostId !== this.hostId) {
      return null
    }
    if (pending.admission.kind === 'invalid') {
      this.snapshotId = null
      return null
    }

    this.snapshotId = pending.admission.snapshotId
    if (pending.admission.kind === 'full') {
      this.confirmedWorktrees = pending.admission.worktrees
    }
    // Reassert confirmed host rows on unchanged polls too, overriding optimistic local edits.
    return this.confirmedWorktrees
  }
}
