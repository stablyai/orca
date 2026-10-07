/**
 * The workspace a create-worktree launch left `unknown` made, derived on replay and never written.
 *
 * The row recorded, before `git worktree add`, the path and branch it was about to add and the
 * instance id the create would write into that worktree's metadata. A worktree found the way the
 * create finds its own (by path, else by branch) is this launch's only when its metadata names that
 * instance id: another create, or a user's own `git worktree add`, can take the same path between
 * the record and the add, and no path alone tells them apart. A foreign worktree, one with no
 * metadata, or a listing that fails names nothing, and the answer stays exactly what it was.
 *
 * It names the workspace and claims nothing about the agent: an agent may have been asked for, and
 * a replay cannot tell. Temporary: once the host owns the first prompt, a startup pass resumes the
 * launch instead of a replay describing it.
 */

import type { AgentSessionOperationRow } from '../../../../shared/agent-session-operation-ledger'
import { findCreatedWorktree } from '../../../ipc/created-worktree-reconciliation'
import type { RpcContext } from '../core'

export async function keptWorkspaceOfUnknownCreate(
  runtime: Pick<RpcContext['runtime'], 'listDetectedManagedWorktrees'>,
  row: Pick<AgentSessionOperationRow, 'outcome' | 'createIntent'>
): Promise<string | null> {
  const intent = row.createIntent
  // Unchecked on load, as `ownedPane` is, so a row written before the instance id carries none.
  if (
    row.outcome.status !== 'unknown' ||
    typeof intent?.repoId !== 'string' ||
    typeof intent.worktreePath !== 'string' ||
    typeof intent.branchName !== 'string' ||
    typeof intent.instanceId !== 'string' ||
    intent.instanceId.length === 0
  ) {
    return null
  }
  try {
    const listed = await runtime.listDetectedManagedWorktrees(`id:${intent.repoId}`)
    const found = findCreatedWorktree(listed.worktrees, intent.worktreePath, intent.branchName)
    return found?.instanceId === intent.instanceId ? found.id : null
  } catch {
    return null
  }
}
