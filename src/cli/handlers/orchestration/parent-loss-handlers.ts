import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { getOptionalPositiveIntegerFlag, getRequiredStringFlag } from '../../flags'
import { callOrchestrationMutation } from './mutation-request'
import { resolveOrchestrationTerminalHandle } from './terminal-identity'

export const ORCHESTRATION_PARENT_LOSS_HANDLERS: Record<string, CommandHandler> = {
  'orchestration parent-checkpoint': async ({ flags, client, cwd, json }) => {
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const result = await callOrchestrationMutation<{
      checkpoint: { id: string; checkpoint_hash: string; status: string }
    }>(client, flags, 'orchestration.parentCheckpoint', {
      dispatch: getRequiredStringFlag(flags, 'dispatch'),
      oldParent: getRequiredStringFlag(flags, 'old-parent'),
      checkpoint: getRequiredStringFlag(flags, 'checkpoint-state'),
      from
    })
    printResult(
      result,
      json,
      (value) =>
        `Checkpoint ${value.checkpoint.id} [${value.checkpoint.status}] sha256=${value.checkpoint.checkpoint_hash}`
    )
  },

  'orchestration parent-rebind': async ({ flags, client, json }) => {
    const result = await callOrchestrationMutation<{
      oldParent: string
      newParent: string
      oldDispatchId: string
      newDispatchId: string
      coordinatorEpoch: number
      rebindReceiptId: string
      correlationId: string
    }>(client, flags, 'orchestration.parentRebind', {
      checkpoint: getRequiredStringFlag(flags, 'checkpoint'),
      newParent: getRequiredStringFlag(flags, 'new-parent'),
      newParentPaneKey: getRequiredStringFlag(flags, 'new-parent-pane-key'),
      approvedBy: getRequiredStringFlag(flags, 'approved-by'),
      approvalId: getRequiredStringFlag(flags, 'approval-id'),
      leaseMs: getOptionalPositiveIntegerFlag(flags, 'lease-ms')
    })
    printResult(
      result,
      json,
      (value) =>
        `Rebound ${value.oldDispatchId} -> ${value.newDispatchId}; parent ${value.oldParent} -> ${value.newParent}; epoch=${value.coordinatorEpoch}; correlation=${value.correlationId}; receipt=${value.rebindReceiptId}`
    )
  }
}
