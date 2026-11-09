import * as z from 'zod'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { Worktree } from './workspace-list-sections'
import { worktreeCatalogRead } from './worktree-catalog-operations'

// Why: worktree.ps silently truncates at 200; use a high cap so large hosts don't drop workspaces.
export const WORKTREE_PS_FULL_LIMIT = 10_000

export type WorktreeCatalogAdmission<T> =
  | { kind: 'full'; snapshotId: string | null; worktrees: T[] }
  | { kind: 'unchanged'; snapshotId: string }
  // Entries are rows, or indexes into the catalog the caller holds under baseSnapshotId.
  | { kind: 'delta'; snapshotId: string; baseSnapshotId: string; rowsFromBase: (number | T)[] }
  | { kind: 'invalid' }

export type PendingWorktreeCatalog = {
  admission: WorktreeCatalogAdmission<Worktree>
  client: RpcClient
  hostId: string
  requestedSnapshotId: string | null
}

// Keep fetch failure distinct from an empty host catalog (STA-3123).
export type WorktreeCatalogFetchResult =
  | { kind: 'response'; pending: PendingWorktreeCatalog }
  | { kind: 'request_failed'; code: string }

const snapshotIdSchema = z.string().min(1).max(128)

/** The id every reader keys a catalog row by; consumers validate their own projections of the rest. */
export function isWorktreeCatalogRow(row: unknown): row is Worktree {
  return (
    typeof row === 'object' &&
    row !== null &&
    'worktreeId' in row &&
    typeof row.worktreeId === 'string'
  )
}

const catalogRowSchema = z.custom<Worktree>(isWorktreeCatalogRow)

// One unreadable row fails the whole reply: dropping it would shift later deltas' base indexes.
const catalogReplySchema = z.looseObject({
  worktrees: z.array(catalogRowSchema).optional().catch(undefined),
  snapshotId: snapshotIdSchema.optional().catch(undefined),
  unchanged: z.boolean().optional().catch(undefined),
  baseSnapshotId: snapshotIdSchema.optional().catch(undefined),
  rowsFromBase: z
    .array(z.union([z.number(), catalogRowSchema]))
    .optional()
    .catch(undefined)
})

export function admitWorktreeCatalogResponse(
  result: unknown,
  requestedSnapshotId: string | null
): WorktreeCatalogAdmission<Worktree> {
  const parsed = catalogReplySchema.safeParse(result)
  if (!parsed.success) {
    return { kind: 'invalid' }
  }
  const { worktrees, unchanged, baseSnapshotId, rowsFromBase } = parsed.data
  const snapshotId = parsed.data.snapshotId ?? null
  // Rows identify a full response; a future unchanged field must not reclassify one.
  if (worktrees) {
    return { kind: 'full', snapshotId, worktrees }
  }
  if (unchanged === true && snapshotId && snapshotId === requestedSnapshotId) {
    return { kind: 'unchanged', snapshotId }
  }
  if (
    snapshotId &&
    requestedSnapshotId !== null &&
    baseSnapshotId === requestedSnapshotId &&
    rowsFromBase
  ) {
    return { kind: 'delta', snapshotId, baseSnapshotId, rowsFromBase }
  }
  return { kind: 'invalid' }
}

export type WorktreeCatalogSnapshotParams = {
  afterSnapshotId?: string | null
  acceptRowDelta: true
}

/** Sends one catalog read with the snapshot fields; the refusal code is the host's, or request_failed. */
export type WorktreeCatalogRequest = (
  client: RpcClient,
  snapshot: WorktreeCatalogSnapshotParams
) => Promise<{ accepted: true; value: unknown } | { accepted: false; code: string }>

const desktopCatalogRequest: WorktreeCatalogRequest = async (client, snapshot) => {
  const reply = await worktreeCatalogRead.request(client, {
    limit: WORKTREE_PS_FULL_LIMIT,
    ...snapshot
  })
  const catalog = worktreeCatalogRead.interpret(reply)
  if (catalog.accepted) {
    return { accepted: true, value: catalog.value }
  }
  // The refusal code the caller reports lives on the envelope; no acceptance policy carries it.
  const code = reply.ok ? undefined : reply.error?.code
  return {
    accepted: false,
    code: typeof code === 'string' && code.length > 0 ? code : 'request_failed'
  }
}

type CatalogRead = { client: RpcClient; hostId: string; rows: Promise<Worktree[] | null> }

export class WorktreeCatalogSnapshotClient {
  private client: RpcClient | null = null
  private hostId: string | null = null
  private snapshotId: string | null = null
  private confirmedWorktrees: Worktree[] | null = null
  private inFlight: CatalogRead | null = null
  private trailing: CatalogRead | null = null

  /** @param request The catalog this client snapshots; the desktop's own worktree.ps when absent. */
  constructor(private readonly request: WorktreeCatalogRequest = desktopCatalogRequest) {}

  async fetch(client: RpcClient, hostId: string): Promise<WorktreeCatalogFetchResult> {
    if (this.client !== client || this.hostId !== hostId) {
      this.client = client
      this.hostId = hostId
      this.snapshotId = null
      this.confirmedWorktrees = null
    }
    const requestedSnapshotId = this.snapshotId
    const catalog = await this.request(client, {
      afterSnapshotId: requestedSnapshotId,
      acceptRowDelta: true
    })
    if (!catalog.accepted) {
      return { kind: 'request_failed', code: catalog.code }
    }
    return {
      kind: 'response',
      pending: {
        admission: admitWorktreeCatalogResponse(catalog.value, requestedSnapshotId),
        client,
        hostId,
        requestedSnapshotId
      }
    }
  }

  /**
   * Fetches and admits one catalog, null when refused or not rebuildable after one full re-read.
   * Callers keep one instance per client; a switch resets the snapshot. One read per client and host at a time: concurrent reads from one base would discard each other's
   * delta. A read asked mid-flight joins one trailing read, so it never settles with rows older than its ask.
   */
  read(client: RpcClient, hostId: string): Promise<Worktree[] | null> {
    const matches = (read: CatalogRead | null): read is CatalogRead =>
      read !== null && read.client === client && read.hostId === hostId
    if (!matches(this.inFlight)) {
      return this.startRead(client, hostId)
    }
    if (!matches(this.trailing)) {
      const start = () => this.startRead(client, hostId)
      this.trailing = { client, hostId, rows: this.inFlight.rows.then(start, start) }
    }
    return this.trailing.rows
  }

  private startRead(client: RpcClient, hostId: string): Promise<Worktree[] | null> {
    if (this.trailing?.client === client && this.trailing.hostId === hostId) {
      this.trailing = null
    }
    const read: CatalogRead = {
      client,
      hostId,
      rows: this.readOnce(client, hostId).finally(() => {
        if (this.inFlight === read) {
          this.inFlight = null
        }
      })
    }
    this.inFlight = read
    return read.rows
  }

  private async readOnce(client: RpcClient, hostId: string): Promise<Worktree[] | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const fetched = await this.fetch(client, hostId)
      if (fetched.kind === 'request_failed') {
        return null
      }
      const rows = this.admit(fetched.pending)
      // Only a delta that failed to rebuild for the current owner is worth one full re-read.
      const owner = this.client === client && this.hostId === hostId
      if (rows || !owner || fetched.pending.admission.kind !== 'delta') {
        return rows
      }
    }
    return null
  }

  /** The confirmed host catalog to apply, or null when there is nothing to apply. */
  admit(pending: PendingWorktreeCatalog): Worktree[] | null {
    // Discard stale client/host replies without invalidating the current session’s token.
    if (pending.client !== this.client || pending.hostId !== this.hostId) {
      return null
    }
    // A late unchanged or delta reply answers a token this client no longer holds; its base is gone.
    if (pending.admission.kind !== 'full' && pending.requestedSnapshotId !== this.snapshotId) {
      return null
    }
    const held = this.confirmedWorktrees && {
      snapshotId: this.snapshotId,
      worktrees: this.confirmedWorktrees
    }
    const next = applyWorktreeCatalogAdmission(held, pending.admission)
    if (!next) {
      this.snapshotId = null
      return null
    }
    this.snapshotId = next.snapshotId
    this.confirmedWorktrees = next.worktrees
    // Reassert confirmed host rows on unchanged polls too, overriding optimistic local edits.
    // A copy: the next delta indexes into these rows, so a caller sorting in place must not reorder them.
    return [...next.worktrees]
  }
}

export type WorktreeCatalogSnapshot = { snapshotId: string | null; worktrees: Worktree[] }

/** The catalog an admitted reply describes on top of `held`; null when it can't be rebuilt from it. */
function applyWorktreeCatalogAdmission(
  held: WorktreeCatalogSnapshot | null,
  admission: WorktreeCatalogAdmission<Worktree>
): WorktreeCatalogSnapshot | null {
  if (admission.kind === 'full') {
    return { snapshotId: admission.snapshotId, worktrees: admission.worktrees }
  }
  if (admission.kind === 'invalid' || !held || held.snapshotId === null) {
    return null
  }
  if (admission.kind === 'unchanged') {
    return admission.snapshotId === held.snapshotId ? held : null
  }
  if (admission.baseSnapshotId !== held.snapshotId) {
    return null
  }
  const worktrees = rebuildFromBase(admission.rowsFromBase, held.worktrees)
  return worktrees && { snapshotId: admission.snapshotId, worktrees }
}

/** A catalog read refused by the host, or a reply no catalog can be built from; `code` is shown verbatim (STA-3123). */
export class WorktreeCatalogReadError extends Error {
  constructor(readonly code: string) {
    super(`worktree catalog read failed: ${code}`)
  }
}

/**
 * Reads the desktop catalog on top of the one the caller holds: an unchanged reply returns `held`
 * itself, a delta rebuilds from its rows, and a delta that can't be rebuilt asks once in full.
 */
export async function readWorktreeCatalogSnapshot(
  client: RpcClient,
  held: WorktreeCatalogSnapshot | undefined
): Promise<WorktreeCatalogSnapshot> {
  let base = held?.snapshotId ? held : null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const requestedSnapshotId = base?.snapshotId ?? null
    const catalog = await desktopCatalogRequest(client, {
      afterSnapshotId: requestedSnapshotId,
      acceptRowDelta: true
    })
    if (!catalog.accepted) {
      throw new WorktreeCatalogReadError(catalog.code)
    }
    const admission = admitWorktreeCatalogResponse(catalog.value, requestedSnapshotId)
    const next = applyWorktreeCatalogAdmission(base, admission)
    if (next) {
      return next
    }
    if (admission.kind !== 'delta') {
      break
    }
    base = null
  }
  throw new WorktreeCatalogReadError('invalid_response')
}

// Null when an index falls outside the base; the caller then asks for a full catalog.
function rebuildFromBase(rowsFromBase: (number | Worktree)[], base: Worktree[]): Worktree[] | null {
  const rows: Worktree[] = []
  for (const entry of rowsFromBase) {
    if (typeof entry !== 'number') {
      rows.push(entry)
      continue
    }
    const row = Number.isInteger(entry) ? base[entry] : undefined
    if (!row) {
      return null
    }
    rows.push(row)
  }
  return rows
}
