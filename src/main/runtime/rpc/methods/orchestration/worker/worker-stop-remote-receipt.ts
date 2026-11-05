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
  const helpers = HelperStopOutcome.array().safeParse(remote.helpers)
  return helpers.success && helpers.data.length ? { helpers: helpers.data } : {}
}
