import type { z } from 'zod'
import { WorkerStartParams } from '../../../../../../shared/rpc-contract/orchestration-worker-start-params'
export { OptionalWorkerLaunchPreference } from '../../../../../../shared/rpc-contract/orchestration-worker-start-params'
export { WorkerStartParams }

export type WorkerStartInput = z.infer<typeof WorkerStartParams>
