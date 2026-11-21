import type { PersistedState } from '../../../shared/orca-profiles/persisted-state-types'
import type { WorkspaceCleanupPolicyGuard } from '../../../shared/workspace-cleanup/workspace-cleanup-policy-change'
import { captureWorkspaceCleanupPolicyState } from '../../../shared/workspace-cleanup/workspace-cleanup-policy-change'
import { WorkspaceCleanupGuardParam } from '../../../shared/rpc-contract/workspace-cleanup/workspace-cleanup-change-params'

const receipts = new Map<
  string,
  {
    expiresAt: number
    outcome: 'pending' | 'applied' | 'cancelled'
    owner?: string | symbol
    expected?: string
  }
>()
export const WORKSPACE_CLEANUP_WRITE_LEASE_MS = 15 * 60 * 1000
const MAX_RECEIPTS = 4096
type CleanupWriteOwner = { getProfileStorageDirectory?: () => string }
const ownerTokens = new WeakMap<object, symbol>()
function ownerToken(owner: CleanupWriteOwner): string | symbol {
  const directory = owner.getProfileStorageDirectory?.()
  if (directory) {
    return directory
  }
  let token = ownerTokens.get(owner)
  if (!token) {
    token = Symbol()
    ownerTokens.set(owner, token)
  }
  return token
}

function pruneReceipts(): void {
  const now = Date.now()
  for (const [id, receipt] of receipts) {
    if (receipt.expiresAt <= now) {
      receipts.delete(id)
    }
  }
}

/** Cancelling an unseen request fences its later arrival; expiry also fences delayed writers. */
export function settleWorkspaceCleanupPolicyWrite(
  id: string,
  expiresAt: number
): 'applied' | 'cancelled' | 'unknown' {
  pruneReceipts()
  const receipt = receipts.get(id)
  if (receipt) {
    if (receipt.outcome === 'pending') {
      receipt.outcome = 'cancelled'
    }
    return receipt.outcome
  }
  if (expiresAt <= Date.now()) {
    return 'unknown'
  }
  if (receipts.size >= MAX_RECEIPTS) {
    throw new Error('workspace_cleanup_busy')
  }
  receipts.set(id, { expiresAt, outcome: 'cancelled' })
  return 'cancelled'
}

/** Must run before the first mutation, including clear-field deletes, with no intervening await. */
export function beginWorkspaceCleanupPolicyWrite(
  state: Pick<PersistedState, 'repos'> & Partial<Pick<PersistedState, 'settings'>>,
  input: WorkspaceCleanupPolicyGuard | undefined,
  repoId: string | null,
  hostId?: string
): void {
  if (!input) {
    return
  }
  const guard = WorkspaceCleanupGuardParam.parse(input)
  pruneReceipts()
  const receipt = receipts.get(guard.id)
  if (
    guard.expected.repoId !== repoId ||
    guard.expiresAt <= Date.now() ||
    guard.expiresAt > Date.now() + WORKSPACE_CLEANUP_WRITE_LEASE_MS ||
    (receipt && receipt.outcome !== 'pending') ||
    (guard.requireReservation &&
      (!receipt ||
        receipt.expected !== JSON.stringify(guard.expected) ||
        receipt.expiresAt !== guard.expiresAt))
  ) {
    throw new Error('workspace_cleanup_policy_conflict')
  }
  if (
    repoId &&
    !guard.expected.projects.some((row) => row.id === repoId && row.hostId === hostId)
  ) {
    throw new Error('workspace_cleanup_policy_conflict')
  }
  const current = captureWorkspaceCleanupPolicyState(state.settings ?? {}, state.repos, repoId)
  if (JSON.stringify(current) !== JSON.stringify(guard.expected)) {
    throw new Error('workspace_cleanup_policy_conflict')
  }
  if (!receipt && receipts.size >= MAX_RECEIPTS) {
    throw new Error('workspace_cleanup_busy')
  }
  // Once mutation begins, a lost reply must read the resulting policy rather than assume failure.
  receipts.set(guard.id, { ...receipt, expiresAt: guard.expiresAt, outcome: 'applied' })
}

export function reserveWorkspaceCleanupPolicyWrite(
  owner: CleanupWriteOwner,
  input: WorkspaceCleanupPolicyGuard
): void {
  const guard = WorkspaceCleanupGuardParam.parse(input)
  pruneReceipts()
  if (
    guard.expiresAt <= Date.now() ||
    guard.expiresAt > Date.now() + WORKSPACE_CLEANUP_WRITE_LEASE_MS ||
    receipts.has(guard.id)
  ) {
    throw new Error('workspace_cleanup_policy_conflict')
  }
  if (receipts.size >= MAX_RECEIPTS) {
    throw new Error('workspace_cleanup_busy')
  }
  receipts.set(guard.id, {
    expiresAt: guard.expiresAt,
    outcome: 'pending',
    owner: ownerToken(owner),
    expected: JSON.stringify(guard.expected)
  })
}
export function hasPendingWorkspaceCleanupWrites(owner: CleanupWriteOwner): boolean {
  pruneReceipts()
  const token = ownerToken(owner)
  return [...receipts.values()].some(
    (receipt) => receipt.owner === token && receipt.outcome === 'pending'
  )
}
export function recoverWorkspaceCleanupPolicyWrites(owner: CleanupWriteOwner): boolean {
  // Only explicit request settlement or lease expiry may fence another client's live writer.
  return hasPendingWorkspaceCleanupWrites(owner)
}
