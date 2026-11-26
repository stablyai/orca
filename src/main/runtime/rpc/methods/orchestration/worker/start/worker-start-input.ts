import type { z } from 'zod'
import type { WorkerStartParams } from '../../../../../../../shared/rpc-contract/orchestration/orchestration-worker-start-params'

export type WorkerStartInput = z.infer<typeof WorkerStartParams>
