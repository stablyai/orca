import { getOptionalStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import {
  INVALID_ORCHESTRATION_BUSY_DELIVERY_MESSAGE,
  isOrchestrationBusyDelivery,
  type OrchestrationBusyDelivery
} from '../../../shared/orchestration-busy-delivery'

/** `--delivery`, refused here so an older runtime that would drop it never sees a bad value. */
export function getOptionalBusyDeliveryFlag(
  flags: Map<string, string | boolean>
): OrchestrationBusyDelivery | undefined {
  const value = getOptionalStringFlag(flags, 'delivery')
  if (value === undefined) {
    return undefined
  }
  if (!isOrchestrationBusyDelivery(value)) {
    throw new RuntimeClientError('invalid_argument', INVALID_ORCHESTRATION_BUSY_DELIVERY_MESSAGE)
  }
  return value
}
