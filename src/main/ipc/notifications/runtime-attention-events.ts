import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type {
  NotificationAttentionAcknowledgement,
  RetainedAgentAttention
} from '../../../shared/notifications/notification-settings-types'

/** Routes the runtime's attention acknowledgements and retained agent notices to this desktop. */
export function subscribeRuntimeAttention(
  runtime: OrcaRuntimeService | undefined,
  acknowledge: (acknowledgement: NotificationAttentionAcknowledgement) => unknown,
  receive: (notificationId: string, notice: RetainedAgentAttention | null) => void
): (() => void) | undefined {
  return runtime?.onClientEvent?.(
    (event) => {
      if (event.type === 'notificationAttentionAcknowledged') {
        acknowledge(event.acknowledgement)
      } else if (event.type === 'agentAttentionChanged') {
        receive(event.notificationId, event.notice)
      }
    },
    { consumesTerminalSideEffects: false }
  )
}
