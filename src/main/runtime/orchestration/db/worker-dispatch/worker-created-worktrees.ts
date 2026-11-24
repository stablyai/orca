import {
  WORKER_SETTLED_STATES,
  type WorkerTerminalReleaseState
} from '../../terminal-authority/release/worker-terminal-ownership'
import type { WorkerDispatchState } from '../orchestration-records'
import { dispatchCompletionEpoch } from '../dispatch-context/dispatch-completion-epoch'
import type { OrchestrationDb } from '../orchestration-db'
import { parseWorkerTerminalPriorOwnerIds } from '../pane-key-match'
import { readWorkerTerminalHostScope } from '../../../../../shared/orchestration/workers/worker-terminal-host-scope'

export type WorkerCreatedWorktree = {
  /** When the newest creating worker's terminal started; a workspace made later at that path is not the worker's. */
  workerStartedAt: number
  /** Every dispatch that used the workspace has released its terminal or settled without one. */
  released: boolean
}

type WorkerWorktreeUseRow = {
  dispatch_id: string
  worktree_id: string
  state: WorkerDispatchState
  effects: string
  terminal_handle: string | null
}

type WorkerTerminalRow = {
  origin_dispatch_id: string
  owner_dispatch_id: string
  prior_owner_dispatch_ids: string
  created_at: string
  host_scope: string | null
  worktree_id: string | null
  release_state: WorkerTerminalReleaseState
}

/** Workspaces a worker start created, keyed by worktree id. Reused workspaces are never listed. */
export function listWorkerCreatedWorktrees(
  db: OrchestrationDb
): Map<string, WorkerCreatedWorktree> {
  // Local workers live in worker_dispatches; on a federated worker's host they live in remote_dispatch_attachments.
  // A worker still starting in an existing workspace has only its resolved target, not worktree_id yet.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the query selects exactly these columns.
  const rows = db.db
    .prepare(
      `SELECT * FROM (
         SELECT dispatch_id, state, effects, agent_terminal_handle AS terminal_handle,
                COALESCE(worktree_id, CASE WHEN json_valid(start_options)
                  THEN json_extract(start_options, '$.resolvedWorktreeId') END) AS worktree_id
           FROM worker_dispatches
       ) WHERE worktree_id IS NOT NULL
       UNION ALL
       SELECT dispatch_id, state, effects, terminal_handle, worktree_id
         FROM remote_dispatch_attachments WHERE worktree_id IS NOT NULL`
    )
    .all() as WorkerWorktreeUseRow[]
  const terminals = readWorkerTerminals(db)
  const uses = new Map<string, { startedAt: number | null; held: boolean }>()
  for (const row of rows) {
    const use = uses.get(row.worktree_id) ?? { startedAt: null, held: false }
    const startedAt = terminals.startedAtByOrigin.get(row.dispatch_id)
    if (startedAt !== undefined && createdWorktree(row.effects, row.worktree_id)) {
      use.startedAt = Math.max(use.startedAt ?? 0, startedAt)
    }
    // A terminal row speaks for its owner; a dispatch whose terminal moved on, or never existed, holds nothing once settled.
    use.held ||=
      !terminals.owners.has(row.dispatch_id) &&
      ((row.terminal_handle !== null && !terminals.handedOff.has(row.dispatch_id)) ||
        !WORKER_SETTLED_STATES.includes(row.state))
    uses.set(row.worktree_id, use)
  }
  const created = new Map<string, WorkerCreatedWorktree>()
  for (const [worktreeId, use] of uses) {
    if (use.startedAt !== null) {
      created.set(worktreeId, {
        workerStartedAt: use.startedAt,
        released:
          !use.held &&
          terminals.releasedWorktreeIds.has(worktreeId) &&
          !terminals.heldWorktreeIds.has(worktreeId)
      })
    }
  }
  return created
}

function readWorkerTerminals(db: OrchestrationDb): {
  startedAtByOrigin: Map<string, number>
  owners: Set<string>
  handedOff: Set<string>
  releasedWorktreeIds: Set<string>
  heldWorktreeIds: Set<string>
} {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the query selects exactly these columns.
  const rows = db.db
    .prepare(
      `SELECT origin_dispatch_id, owner_dispatch_id, prior_owner_dispatch_ids, created_at,
              host_scope, worktree_id, release_state
         FROM worker_terminal_resources`
    )
    .all() as WorkerTerminalRow[]
  const terminals = {
    startedAtByOrigin: new Map<string, number>(),
    owners: new Set<string>(),
    handedOff: new Set<string>(),
    releasedWorktreeIds: new Set<string>(),
    heldWorktreeIds: new Set<string>()
  }
  for (const row of rows) {
    const startedAt = dispatchCompletionEpoch(row.created_at)
    // An SSH worker's workspace can share its id with one on this machine; only this machine's workers count.
    const hostScope = readWorkerTerminalHostScope(row.host_scope).kind
    if (startedAt !== null && (hostScope === 'absent' || hostScope === 'local')) {
      terminals.startedAtByOrigin.set(row.origin_dispatch_id, startedAt)
    }
    terminals.owners.add(row.owner_dispatch_id)
    for (const dispatchId of parseWorkerTerminalPriorOwnerIds(row.prior_owner_dispatch_ids) ?? []) {
      terminals.handedOff.add(dispatchId)
    }
    // Includes a terminal placed in the workspace before its dispatch recorded the workspace.
    if (row.worktree_id !== null && row.release_state === 'released') {
      terminals.releasedWorktreeIds.add(row.worktree_id)
    } else if (row.worktree_id !== null) {
      terminals.heldWorktreeIds.add(row.worktree_id)
    }
  }
  return terminals
}

function createdWorktree(effectsJson: string, worktreeId: string): boolean {
  try {
    const effects: unknown = JSON.parse(effectsJson)
    return (
      Array.isArray(effects) &&
      effects.some(
        (effect) =>
          effect?.kind === 'worktree' &&
          effect.id === worktreeId &&
          (effect.action === 'created_child' || effect.action === 'created_top_level')
      )
    )
  } catch {
    return false
  }
}
