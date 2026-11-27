import type { z } from 'zod'
import type { WorkerStartParams } from '../../../../../../../shared/rpc-contract/orchestration/orchestration-worker-start-params'

export type WorkerStartInput = z.infer<typeof WorkerStartParams> & {
  /** Set internally when `model`/`effort` were defaulted from `--retry-of`, never supplied by callers. */
  inheritedLaunchPreferences?: boolean
}
