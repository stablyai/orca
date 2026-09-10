import { z } from 'zod'
import type { RuntimeStatus } from '../../../../shared/runtime-types'

/** Validates a remote federated release receipt and names the unverifiable fallback. */
export const RemoteFederatedWorkerReleaseReceiptSchema = z
  .object({
    dispatchId: z.string().min(1),
    runtimeEpoch: z.string().min(1),
    servingRuntimeEpoch: z.string().min(1).optional(),
    state: z.enum(['released', 'already_released', 'retained', 'unverifiable']),
    reason: z.enum(['identity_unproven']).optional(),
    processAction: z.enum(['closed_agent_terminal', 'none']),
    lastError: z.string().optional(),
    recovery: z.string().optional(),
    attachment: z.object({
      terminalHandle: z.string().min(1),
      paneKey: z.string().min(1),
      processIncarnation: z.string().min(1)
    })
  })
  .superRefine((receipt, context) => {
    if (receipt.state === 'released' && receipt.processAction !== 'closed_agent_terminal') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'released_process_action_mismatch' })
    }
    if (receipt.state !== 'released' && receipt.processAction !== 'none') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'nonreleased_process_action_mismatch'
      })
    }
    if (receipt.reason && receipt.state !== 'retained') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'release_reason_state_mismatch' })
    }
  })

export const RemoteFederatedWorkerReleaseStatusSchema = z.object({
  runtimeId: z.string().min(1),
  capabilities: z.array(z.string()).optional()
}) satisfies z.ZodType<Pick<RuntimeStatus, 'runtimeId' | 'capabilities'>>

export function matchesFederatedReleaseTarget(
  receipt: z.infer<typeof RemoteFederatedWorkerReleaseReceiptSchema>,
  args: {
    dispatchId: string
    federated: {
      remote_terminal_handle: string | null
    }
    dispatch:
      | {
          assignee_handle: string | null
          assignee_pane_key: string | null
          process_incarnation: string | null
        }
      | undefined
    worker: { agent_terminal_handle: string | null } | undefined
    runtimeEpoch: string
  }
): boolean {
  if (
    receipt.dispatchId !== args.dispatchId ||
    (receipt.servingRuntimeEpoch ?? receipt.runtimeEpoch) !== args.runtimeEpoch ||
    !args.federated.remote_terminal_handle ||
    !args.dispatch?.assignee_handle ||
    !args.dispatch.assignee_pane_key ||
    !args.dispatch.process_incarnation ||
    !args.worker?.agent_terminal_handle
  ) {
    return false
  }
  return (
    receipt.attachment.terminalHandle === args.federated.remote_terminal_handle &&
    receipt.attachment.terminalHandle === args.dispatch.assignee_handle &&
    receipt.attachment.terminalHandle === args.worker.agent_terminal_handle &&
    receipt.attachment.paneKey === args.dispatch.assignee_pane_key &&
    receipt.attachment.processIncarnation === args.dispatch.process_incarnation
  )
}

export function unverifiableFederatedReleaseReceipt(
  dispatchId: string,
  lastError: string
): FederatedWorkerReleaseReceipt {
  return {
    dispatchId,
    state: 'unverifiable',
    processAction: 'none',
    archive: null,
    lastError,
    recovery:
      'The execution host could not confirm this release. Reconnect and retry with the same request ID; do not close a local terminal.'
  }
}

export type FederatedWorkerReleaseReceipt = {
  dispatchId: string
  state: 'released' | 'already_released' | 'retained' | 'unverifiable'
  /** Why the terminal stayed retained; each value is a distinct, provable verdict. */
  reason?: 'identity_unproven' | 'federation_unsupported' | 'no_owned_resource' | 'user_requested'
  processAction: 'closed_agent_terminal' | 'none'
  archive: null
  lastError?: string
  recovery?: string
}
