import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { BOT_HANDOFF_LAUNCH_RELAY_REFUSAL } from '../../../../../../shared/orchestration/bot-handoff-launch-options'
import type { RpcCallerScope } from '../../../callers/rpc-caller-scope'
import type { RpcDispatchStreamingOptions } from '../../../dispatch/dispatcher-stream-options'
import { isConversationReportOutcome, parseRemoteWorkerPayload } from './message-payload'

export function assertLocalBotHandoffLaunch(
  params: unknown,
  scope: RpcCallerScope,
  transport: RpcDispatchStreamingOptions | undefined
): void {
  if (!params || typeof params !== 'object') {
    return
  }
  if (
    (scope.kind !== 'owner' ||
      transport?.pairedDeviceId !== undefined ||
      transport?.caller?.kind === 'paired-device') &&
    (('model' in params && params.model !== undefined) ||
      ('effort' in params && params.effort !== undefined))
  ) {
    throw new OrchestrationError('capability_unsupported', BOT_HANDOFF_LAUNCH_RELAY_REFUSAL, {
      effectsApplied: false
    })
  }
}

/** Refuses a send whose type and recipient can never be delivered, before any effect. */
export function assertSendParamsDeliverable(params: {
  type?: string
  to?: string
  payload?: string
}): void {
  if (
    params.type === 'worker_done' &&
    !isConversationReportOutcome(parseRemoteWorkerPayload(params.payload).outcome)
  ) {
    throw new OrchestrationError(
      'invalid_argument',
      'worker_done requires outcome=succeeded|failed for a current Dispatch.'
    )
  }
  if (params.to?.startsWith('task:')) {
    throw new OrchestrationError(
      'invalid_argument',
      'Task recipients are intentionally unsupported; use run:<id> or dispatch:<id>.'
    )
  }
}
