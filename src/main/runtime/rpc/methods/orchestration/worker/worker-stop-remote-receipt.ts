import { z } from 'zod'
import { ORCHESTRATION_WORKER_STOP_HELPERS_RUNTIME_CAPABILITY } from '../../../../../../shared/orchestration-runtime-capabilities'
import {
  HelperStopOutcome,
  type WorkerStopReceipt
} from '../../../../../../shared/orchestration-worker-stop-receipt'

export const RemoteCapabilities = z.object({ capabilities: z.array(z.string()).optional() })

export const RemoteStopReceipt = z.object({
  state: z.string(),
  alreadySettled: z.boolean(),
  processAction: z.string(),
  close: z.unknown().optional(),
  lastError: z.string().nullable().optional(),
  helpers: z.unknown().optional()
})
export type RemoteStopReceipt = z.infer<typeof RemoteStopReceipt>

/** Helpers the worker's host stopped under it; an older host stops none, so say so. */
export function remoteHelpers(
  remote: RemoteStopReceipt,
  status: z.infer<typeof RemoteCapabilities>,
  serverName: string
): Pick<WorkerStopReceipt, 'helpers' | 'warning'> {
  if (!status.capabilities?.includes(ORCHESTRATION_WORKER_STOP_HELPERS_RUNTIME_CAPABILITY)) {
    return {
      warning: `${serverName} runs an older Orca that leaves helpers this worker started there running; update it to stop them with the worker.`
    }
  }
  const items = Array.isArray(remote.helpers) ? remote.helpers : []
  return items.length ? { helpers: items.map(readRemoteHelper) } : {}
}

const RemoteHelper = HelperStopOutcome.extend({ outcome: z.string() })

/** A host newer than this home may report an outcome it does not know; never claim that stopped. */
function readRemoteHelper(item: unknown): HelperStopOutcome {
  const helper = RemoteHelper.safeParse(item)
  if (!helper.success) {
    return {
      dispatchId: 'unknown',
      creatorDispatchId: 'unknown',
      outcome: 'unconfirmed',
      lastError: 'The host reported a helper this Orca cannot read.'
    }
  }
  const outcome = HelperStopOutcome.shape.outcome.safeParse(helper.data.outcome)
  return outcome.success
    ? { ...helper.data, outcome: outcome.data }
    : {
        ...helper.data,
        outcome: 'unconfirmed',
        lastError: `The host reported ${helper.data.outcome}.`
      }
}
