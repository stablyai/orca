import { randomBytes } from 'node:crypto'
import { OrchestrationError } from '../../orchestration-error'
import { hashDispatchCapability } from '../dispatch-capability-hash'
import type { OrchestrationDb } from '../orchestration-db'

// Why: argv-injected worker starts need the capability text BEFORE the worker
// terminal exists — the dispatch preamble is baked into the agent's launch
// argv, so it cannot wait for a pane. Minting is safe pre-bind because
// verifyDispatchCapability refuses any use until assignee_pane_key and
// process_incarnation are bound: an unbound capability authorizes nothing.
export function mintStartingWorkerCapability(
  this: OrchestrationDb,
  params: { dispatchId: string }
): string {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = this.getDispatchContextById(params.dispatchId)
    const worker = this.getWorkerDispatch(params.dispatchId)
    if (!dispatch || dispatch.status !== 'pending' || worker?.state !== 'starting') {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${params.dispatchId} is not starting.`
      )
    }
    // Why: the plaintext is returned exactly once; a second mint could not
    // reproduce it and would silently orphan the capability already baked
    // into a launch argv. Refuse instead of rotating.
    if (dispatch.capability_hash) {
      throw new OrchestrationError(
        'request_mismatch',
        `Dispatch ${params.dispatchId} already has a lifecycle capability.`
      )
    }
    if (dispatch.capability_revoked_at) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${params.dispatchId} capability is revoked.`
      )
    }
    const capability = `dcap_${randomBytes(32).toString('base64url')}`
    const contextUpdate = this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET capability_hash = ?
         WHERE id = ? AND status = 'pending' AND capability_hash IS NULL`
      )
      .run(hashDispatchCapability(capability), params.dispatchId)
    if (contextUpdate.changes !== 1) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${params.dispatchId} is not starting.`
      )
    }
    this.db.exec('COMMIT')
    return capability
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

// Why: the post-spawn half of an argv worker start. Everything
// prepareStartingWorkerAuthority does EXCEPT capability generation, plus two
// hardened guards: the launch-token commitment is REQUIRED to match (it is the
// only proof the binding pane is the exact process that received
// ORCA_AGENT_LAUNCH_TOKEN at spawn), and a revoked capability is never
// resurrected — the atomic mint+bind clears capability_revoked_at because
// nothing can revoke inside one transaction; across two transactions that
// reset would resurrect a capability revoked between mint and bind.
export function bindStartingWorkerAuthority(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    handle: string
    paneKey: string
    processIncarnation: string
    launchTokenHash?: string
    worktreeId: string
    effects: unknown[]
    setupState: string
    hostScope?: string | null
    terminalOwnership?: 'created' | 'external'
  }
): void {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = this.getDispatchContextById(params.dispatchId)
    const worker = this.getWorkerDispatch(params.dispatchId)
    if (!dispatch || dispatch.status !== 'pending' || worker?.state !== 'starting') {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${params.dispatchId} is not starting.`
      )
    }
    if (!dispatch.capability_hash) {
      throw new OrchestrationError(
        'request_mismatch',
        `Dispatch ${params.dispatchId} has no minted capability to bind.`
      )
    }
    if (dispatch.capability_revoked_at) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${params.dispatchId} capability is revoked.`
      )
    }
    if (
      !dispatch.launch_token_hash ||
      dispatch.launch_token_hash !== (params.launchTokenHash ?? null)
    ) {
      throw new OrchestrationError(
        'request_mismatch',
        `Dispatch ${params.dispatchId} launch-token commitment does not match the binding pane.`
      )
    }
    const existing = this.findActiveDispatchForAssignee(params.handle, params.paneKey)
    if (existing && existing.id !== params.dispatchId) {
      throw new Error(
        `Terminal ${params.handle} already has an active dispatch (${existing.id} for task ${existing.task_id})`
      )
    }
    const contextUpdate = this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET assignee_handle = ?, assignee_pane_key = ?, process_incarnation = ?
         WHERE id = ? AND status = 'pending' AND capability_revoked_at IS NULL`
      )
      .run(params.handle, params.paneKey, params.processIncarnation, params.dispatchId)
    if (contextUpdate.changes !== 1) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${params.dispatchId} is not starting.`
      )
    }
    const workerUpdate = this.db
      .prepare(
        `UPDATE worker_dispatches
         SET stage = 'authority_attached', worktree_id = ?, agent_terminal_handle = ?,
             setup_state = ?, effects = ?, residual_resources = ?, updated_at = datetime('now')
         WHERE dispatch_id = ? AND state = 'starting'`
      )
      .run(
        params.worktreeId,
        params.handle,
        params.setupState,
        JSON.stringify(params.effects),
        JSON.stringify(
          params.effects.filter((effect) =>
            Boolean(
              effect &&
              typeof effect === 'object' &&
              ((effect as { action?: string }).action?.startsWith('created') ||
                (effect as { action?: string }).action === 'reused_agent_terminal')
            )
          )
        ),
        params.dispatchId
      )
    if (workerUpdate.changes !== 1) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${params.dispatchId} is not starting.`
      )
    }
    const existingResource = this.getWorkerTerminalResourceByOwner(params.dispatchId)
    if (existingResource) {
      if (
        existingResource.terminal_handle !== params.handle ||
        existingResource.ownership_state !== 'owned'
      ) {
        throw new OrchestrationError(
          'request_mismatch',
          `Dispatch ${params.dispatchId} terminal resource does not match the binding pane.`
        )
      }
      this.bindWorkerTerminalResourceStatement({
        dispatchId: params.dispatchId,
        worktreeId: params.worktreeId,
        terminalHandle: params.handle,
        paneKey: params.paneKey,
        processIncarnation: params.processIncarnation,
        hostScope: params.hostScope ?? null
      })
    } else if (params.terminalOwnership) {
      if (params.terminalOwnership === 'created') {
        this.createWorkerTerminalResourceStatement({
          dispatchId: params.dispatchId,
          worktreeId: params.worktreeId,
          terminalHandle: params.handle,
          paneKey: params.paneKey,
          processIncarnation: params.processIncarnation,
          hostScope: params.hostScope,
          ownership: 'owned'
        })
      } else {
        const transferable = this.findTransferableWorkerTerminalResource({
          terminalHandle: params.handle,
          paneKey: params.paneKey,
          processIncarnation: params.processIncarnation,
          hostScope: params.hostScope ?? null
        })
        if (transferable) {
          this.transferWorkerTerminalResourceStatement({
            resourceId: transferable.id,
            toDispatchId: params.dispatchId,
            terminalHandle: params.handle,
            paneKey: params.paneKey,
            processIncarnation: params.processIncarnation,
            hostScope: params.hostScope ?? null
          })
        } else {
          this.createWorkerTerminalResourceStatement({
            dispatchId: params.dispatchId,
            worktreeId: params.worktreeId,
            terminalHandle: params.handle,
            paneKey: params.paneKey,
            processIncarnation: params.processIncarnation,
            hostScope: params.hostScope,
            ownership: 'external'
          })
        }
      }
    }
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type WorkerDispatchArgvAuthorityMethods = {
  mintStartingWorkerCapability: typeof mintStartingWorkerCapability
  bindStartingWorkerAuthority: typeof bindStartingWorkerAuthority
}

export function attachWorkerDispatchArgvAuthority(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    mintStartingWorkerCapability,
    bindStartingWorkerAuthority
  })
}
