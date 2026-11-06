import type { z } from 'zod'
import {
  FederationAttachStartParams,
  FederationWorkerLaunchParams
} from '../../../../../../shared/rpc-contract/orchestration-federation-start-params'
export { FederationAttachStartParams, FederationWorkerLaunchParams }

export type FederationAttachStartInput = z.infer<typeof FederationAttachStartParams>
export type FederationWorkerLaunchInput = z.infer<typeof FederationWorkerLaunchParams>
