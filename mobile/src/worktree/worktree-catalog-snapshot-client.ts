import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import type { Worktree } from './workspace-list-sections'

// Why: worktree.ps silently truncates at 200; use a high cap so large hosts don't drop workspaces.
export const WORKTREE_PS_FULL_LIMIT = 10_000

export type WorktreeCatalogAdmission<T> =
  | { kind: 'full'; snapshotId: string | null; worktrees: T[] }
  | { kind: 'unchanged'; snapshotId: string }
  | { kind: 'invalid' }

type PendingWorktreeCatalog = {
  admission: WorktreeCatalogAdmission<Worktree>
  client: RpcClient
  hostId: string
}

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
  // Why: a full response is defined by carrying rows, so discriminate on that rather
  // than on the presence of `unchanged` — the latter could collide with a future
  // catalog field and silently reclassify a full response.
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

  async fetch(client: RpcClient, hostId: string): Promise<PendingWorktreeCatalog | null> {
    if (this.client !== client || this.hostId !== hostId) {
      this.client = client
      this.hostId = hostId
      this.snapshotId = null
      this.confirmedWorktrees = null
    }
    const requestedSnapshotId = this.snapshotId
    const response = await client.sendRequest('worktree.ps', {
      limit: WORKTREE_PS_FULL_LIMIT,
      afterSnapshotId: requestedSnapshotId
    })
    if (!response.ok) {
      return null
    }
    return {
      admission: admitWorktreeCatalogResponse<Worktree>(
        (response as RpcSuccess).result,
        requestedSnapshotId
      ),
      client,
      hostId
    }
  }

  /** The confirmed host catalog to apply, or null when there is nothing to apply. */
  admit(pending: PendingWorktreeCatalog | null): Worktree[] | null {
    if (!pending) {
      return null
    }
    // Why: a response from a superseded client/host is stale, not wrong — dropping it
    // must not invalidate the token the current client/host just established.
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
    // Why: unchanged responses still return the confirmed rows so every poll reasserts
    // host truth over optimistic local edits, exactly as the full-payload path did.
    return this.confirmedWorktrees
  }
}
