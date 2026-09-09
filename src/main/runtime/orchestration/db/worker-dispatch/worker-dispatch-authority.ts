import { randomBytes } from 'node:crypto'
import { OrchestrationError } from '../../orchestration-error'
import { hashDispatchCapability } from '../dispatch-capability-hash'
import type { OrchestrationDb } from '../orchestration-db'

export function prepareStartingWorkerAuthority(
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
    // 'created': this worker-start operation created the agent terminal (including agent-first
    // worktree creation, whose effects receipt says 'reused_agent_terminal'). 'external': an
    // explicit --terminal reuse; ownership transfers only from an exact owned settled resource.
    terminalOwnership?: 'created' | 'external'
  }
): string {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    // Why: read inside the transaction so the guarded UPDATEs below cannot lose a race with a concurrent state change.
    const dispatch = this.getDispatchContextById(params.dispatchId)
    const worker = this.getWorkerDispatch(params.dispatchId)
    if (!dispatch || dispatch.status !== 'pending' || worker?.state !== 'starting') {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${params.dispatchId} is not starting.`
      )
    }
    if (
      dispatch.launch_token_hash &&
      params.launchTokenHash &&
      dispatch.launch_token_hash !== params.launchTokenHash
    ) {
      throw new OrchestrationError(
        'request_mismatch',
        `Dispatch ${params.dispatchId} already has a different launch-token commitment.`
      )
    }
    const existing = this.findActiveDispatchForAssignee(params.handle, params.paneKey)
    if (existing && existing.id !== params.dispatchId) {
      throw new Error(
        `Terminal ${params.handle} already has an active dispatch (${existing.id} for task ${existing.task_id})`
      )
    }
    const capability = `dcap_${randomBytes(32).toString('base64url')}`
    const endpointId = this.getWorkerDispatch(params.dispatchId)?.runtime_epoch ?? null
    const contextUpdate = this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET assignee_handle = ?, assignee_pane_key = ?, process_incarnation = ?,
             host_scope = ?,
             capability_hash = ?, launch_token_hash = COALESCE(launch_token_hash, ?),
             capability_revoked_at = NULL,
             consumer_generation = consumer_generation + 1
         WHERE id = ? AND status = 'pending'`
      )
      .run(
        params.handle,
        params.paneKey,
        params.processIncarnation,
        params.hostScope ?? null,
        hashDispatchCapability(capability),
        params.launchTokenHash ?? null,
        params.dispatchId
      )
    if (contextUpdate.changes !== 1) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${params.dispatchId} is not starting.`
      )
    }
    this.fenceOutstandingMailboxDelivery(`dispatch:${params.dispatchId}`)
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
    if (params.terminalOwnership && !this.getWorkerTerminalResourceByOwner(params.dispatchId)) {
      if (params.terminalOwnership === 'created') {
        this.createWorkerTerminalResourceStatement({
          dispatchId: params.dispatchId,
          worktreeId: params.worktreeId,
          terminalHandle: params.handle,
          paneKey: params.paneKey,
          processIncarnation: params.processIncarnation,
          endpointId,
          endpointIncarnation: params.processIncarnation,
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
            endpointId,
            endpointIncarnation: params.processIncarnation,
            hostScope: params.hostScope ?? null
          })
        } else {
          this.createWorkerTerminalResourceStatement({
            dispatchId: params.dispatchId,
            worktreeId: params.worktreeId,
            terminalHandle: params.handle,
            paneKey: params.paneKey,
            processIncarnation: params.processIncarnation,
            endpointId,
            endpointIncarnation: params.processIncarnation,
            hostScope: params.hostScope,
            ownership: 'external'
          })
        }
      }
    }
    this.db.exec('COMMIT')
    return capability
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Custody for an agent terminal this worker-start just created, recorded at creation instead of
 * after the agent boot wait. Until the row exists a keystroke into the booting pane finds no
 * ownership to flip, so the takeover is silently dropped and a later `worker-release` closes the
 * pane under the user.
 *
 * Ownership of a pane only; the Dispatch capability stays behind the boot wait, because authority
 * must not be handed to a process that has not come up.
 */
export function recordCreatedWorkerTerminalCustody(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    handle: string
    paneKey: string
    processIncarnation: string
    worktreeId: string
    hostScope?: string | null
  }
): void {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    // Same guard as prepareStartingWorkerAuthority, read inside the transaction: a dispatch stopped
    // while the terminal was being created must not acquire an owner.
    const dispatch = this.getDispatchContextById(params.dispatchId)
    const worker = this.getWorkerDispatch(params.dispatchId)
    if (!dispatch || dispatch.status !== 'pending' || worker?.state !== 'starting') {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${params.dispatchId} is not starting.`
      )
    }
    if (!this.getWorkerTerminalResourceByOwner(params.dispatchId)) {
      this.createWorkerTerminalResourceStatement({
        dispatchId: params.dispatchId,
        worktreeId: params.worktreeId,
        terminalHandle: params.handle,
        paneKey: params.paneKey,
        processIncarnation: params.processIncarnation,
        endpointId: worker.runtime_epoch,
        endpointIncarnation: params.processIncarnation,
        hostScope: params.hostScope,
        ownership: 'owned'
      })
    }
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type WorkerDispatchAuthorityMethods = {
  prepareStartingWorkerAuthority: typeof prepareStartingWorkerAuthority
  recordCreatedWorkerTerminalCustody: typeof recordCreatedWorkerTerminalCustody
}

export function attachWorkerDispatchAuthority(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    prepareStartingWorkerAuthority,
    recordCreatedWorkerTerminalCustody
  })
}
