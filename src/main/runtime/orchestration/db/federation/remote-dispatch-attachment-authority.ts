import type { RemoteDispatchAttachmentRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { isEquivalentPaneKey } from '../pane-key-match'
import type { OrchestrationDb } from '../orchestration-db'

export function prepareRemoteAttachmentAuthority(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    paneKey: string
    processIncarnation: string
    worktreeId: string
    terminalHandle: string
    setupState: string
    effects: unknown[]
    hostScope?: string | null
    terminalOwnership?: 'created' | 'external'
  }
): void {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const attachment = this.getRemoteDispatchAttachment(params.dispatchId)
    if (!attachment || attachment.state !== 'starting') {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Remote Dispatch ${params.dispatchId} is not starting.`
      )
    }
    const active = this.findActiveRemoteAttachmentForPane(params.paneKey)
    if (active && active.dispatch_id !== params.dispatchId) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Terminal ${params.terminalHandle} already has active remote Dispatch ${active.dispatch_id}.`
      )
    }
    const result = this.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET stage = 'authority_attached', pane_key = ?,
             process_incarnation = ?, worktree_id = ?, terminal_handle = ?, setup_state = ?,
             effects = ?, residual_resources = ?, updated_at = datetime('now'),
             consumer_generation = consumer_generation + 1
         WHERE dispatch_id = ? AND state = 'starting'`
      )
      .run(
        params.paneKey,
        params.processIncarnation,
        params.worktreeId,
        params.terminalHandle,
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
    if (result.changes !== 1) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Remote Dispatch ${params.dispatchId} is not starting.`
      )
    }
    this.fenceUnacknowledgedMailboxDeliveries(`dispatch:${params.dispatchId}`)
    if (params.terminalOwnership && !this.getWorkerTerminalResourceByOwner(params.dispatchId)) {
      const resource =
        params.terminalOwnership === 'external'
          ? this.findTransferableWorkerTerminalResource({
              terminalHandle: params.terminalHandle,
              paneKey: params.paneKey,
              processIncarnation: params.processIncarnation,
              hostScope: params.hostScope ?? null
            })
          : undefined
      if (resource) {
        this.transferWorkerTerminalResourceStatement({
          resourceId: resource.id,
          toDispatchId: params.dispatchId,
          terminalHandle: params.terminalHandle,
          paneKey: params.paneKey,
          processIncarnation: params.processIncarnation,
          endpointId: attachment.runtime_epoch,
          endpointIncarnation: params.processIncarnation,
          hostScope: params.hostScope ?? null
        })
      } else {
        this.createWorkerTerminalResourceStatement({
          dispatchId: params.dispatchId,
          worktreeId: params.worktreeId,
          terminalHandle: params.terminalHandle,
          paneKey: params.paneKey,
          processIncarnation: params.processIncarnation,
          endpointId: attachment.runtime_epoch,
          endpointIncarnation: params.processIncarnation,
          hostScope: params.hostScope,
          ownership: params.terminalOwnership === 'created' ? 'owned' : 'external'
        })
      }
    }
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function markRemoteAttachmentReady(
  this: OrchestrationDb,
  dispatchId: string,
  effects?: unknown[]
): RemoteDispatchAttachmentRow {
  const result = this.db
    .prepare(
      `UPDATE remote_dispatch_attachments
       SET state = 'ready', stage = 'input_accepted',
           effects = COALESCE(?, effects), updated_at = datetime('now')
       WHERE dispatch_id = ? AND state = 'starting'`
    )
    .run(effects ? JSON.stringify(effects) : null, dispatchId)
  if (result.changes !== 1) {
    throw new OrchestrationError(
      'dispatch_inactive',
      `Remote Dispatch ${dispatchId} is not starting.`
    )
  }
  return this.getRemoteDispatchAttachment(dispatchId) as RemoteDispatchAttachmentRow
}

export function failRemoteAttachment(
  this: OrchestrationDb,
  dispatchId: string,
  stage: string,
  reason: string,
  unknown: boolean
): RemoteDispatchAttachmentRow {
  const state = unknown ? 'start_unknown' : 'failed'
  const result = this.db
    .prepare(
      `UPDATE remote_dispatch_attachments
       SET state = ?, stage = ?, last_error = ?, capability_hash = NULL,
           updated_at = datetime('now')
       WHERE dispatch_id = ? AND state = 'starting'`
    )
    .run(state, stage, reason, dispatchId)
  if (result.changes !== 1) {
    throw new OrchestrationError(
      'dispatch_inactive',
      `Remote Dispatch ${dispatchId} is not starting.`
    )
  }
  return this.getRemoteDispatchAttachment(dispatchId) as RemoteDispatchAttachmentRow
}

export function isRemoteAttachmentProcessCurrent(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    paneKey: string | null
    processIncarnation: string | null
  }
): boolean {
  const attachment = this.getRemoteDispatchAttachment(params.dispatchId)
  return Boolean(
    attachment?.pane_key &&
    params.paneKey &&
    isEquivalentPaneKey(attachment.pane_key, params.paneKey) &&
    attachment.process_incarnation &&
    attachment.process_incarnation === params.processIncarnation
  )
}

export type RemoteDispatchAttachmentAuthorityMethods = {
  prepareRemoteAttachmentAuthority: typeof prepareRemoteAttachmentAuthority
  markRemoteAttachmentReady: typeof markRemoteAttachmentReady
  failRemoteAttachment: typeof failRemoteAttachment
  isRemoteAttachmentProcessCurrent: typeof isRemoteAttachmentProcessCurrent
}

export function attachRemoteDispatchAttachmentAuthority(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    prepareRemoteAttachmentAuthority,
    markRemoteAttachmentReady,
    failRemoteAttachment,
    isRemoteAttachmentProcessCurrent
  })
}
