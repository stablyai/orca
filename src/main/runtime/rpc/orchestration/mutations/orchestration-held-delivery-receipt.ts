import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import { OrchestrationError } from '../../../orchestration/orchestration-error'

/** Apply after mutation settlement, including replay: a kept message is never a legacy client's success. */
export function refuseLegacyHeldDelivery(method: string, params: unknown, receipt: unknown): void {
  if (
    method !== 'orchestration.send' ||
    !params ||
    typeof params !== 'object' ||
    ('deliveryOutcome' in params && params.deliveryOutcome === true) ||
    !receipt ||
    typeof receipt !== 'object' ||
    !('state' in receipt) ||
    (receipt.state !== 'held' && receipt.state !== 'unknown')
  ) {
    return
  }
  const message =
    'deliveryMessage' in receipt && typeof receipt.deliveryMessage === 'string'
      ? receipt.deliveryMessage
      : 'Held, not delivered. Delivers when the worker is resumed.'
  throw new OrchestrationError(
    receipt.state === 'held' ? 'recipient_delivery_held' : 'recipient_delivery_unconfirmed',
    message,
    {
      ...receipt,
      messageKept: true
    }
  )
}

export function refuseUnverifiedFailureResume(
  method: string,
  params: unknown,
  db: OrchestrationDb
): void {
  if (
    method === 'orchestration.send' &&
    params &&
    typeof params === 'object' &&
    'resume' in params &&
    params.resume === true
  ) {
    const to = 'to' in params ? params.to : undefined
    if (
      typeof to !== 'string' ||
      !to.startsWith('dispatch:') ||
      db.getFederatedDispatch(to.slice('dispatch:'.length))
    ) {
      throw new OrchestrationError(
        'worker_resume_unsupported',
        'Resume requires an exact Dispatch on the execution host. Nothing was resumed or sent.',
        { effectsApplied: false }
      )
    }
  }
}
