import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { RemoteDispatchAttachmentRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { hashDispatchCapability } from '../dispatch-capability-hash'
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
  }
): string {
  const attachment = this.getRemoteDispatchAttachment(params.dispatchId)
  if (!attachment || attachment.state !== 'starting') {
    throw new OrchestrationError(
      'dispatch_inactive',
      `Remote Dispatch ${params.dispatchId} is not starting.`
    )
  }
  const capability = `dcap_${randomBytes(32).toString('base64url')}`
  const result = this.db
    .prepare(
      `UPDATE remote_dispatch_attachments
       SET stage = 'authority_attached', capability_hash = ?, pane_key = ?,
           process_incarnation = ?, worktree_id = ?, terminal_handle = ?, setup_state = ?,
           effects = ?, residual_resources = ?, updated_at = datetime('now')
       WHERE dispatch_id = ? AND state = 'starting'`
    )
    .run(
      hashDispatchCapability(capability),
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
  // Why: without this the caller keeps a capability whose hash was never stored, surfacing later as an authority mismatch.
  if (result.changes !== 1) {
    throw new OrchestrationError(
      'dispatch_inactive',
      `Remote Dispatch ${params.dispatchId} is not starting.`
    )
  }
  return capability
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

export function verifyRemoteAttachmentAuthority(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    capability: string | undefined
    paneKey: string | null
    processIncarnation: string | null
  }
): boolean {
  const attachment = this.getRemoteDispatchAttachment(params.dispatchId)
  if (
    !attachment?.capability_hash ||
    !params.capability ||
    !attachment.pane_key ||
    !params.paneKey ||
    !isEquivalentPaneKey(attachment.pane_key, params.paneKey) ||
    !attachment.process_incarnation ||
    attachment.process_incarnation !== params.processIncarnation
  ) {
    return false
  }
  const expected = Buffer.from(attachment.capability_hash, 'hex')
  const observed = Buffer.from(hashDispatchCapability(params.capability), 'hex')
  return expected.length === observed.length && timingSafeEqual(expected, observed)
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
  verifyRemoteAttachmentAuthority: typeof verifyRemoteAttachmentAuthority
  isRemoteAttachmentProcessCurrent: typeof isRemoteAttachmentProcessCurrent
}

export function attachRemoteDispatchAttachmentAuthority(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    prepareRemoteAttachmentAuthority,
    markRemoteAttachmentReady,
    failRemoteAttachment,
    verifyRemoteAttachmentAuthority,
    isRemoteAttachmentProcessCurrent
  })
}
