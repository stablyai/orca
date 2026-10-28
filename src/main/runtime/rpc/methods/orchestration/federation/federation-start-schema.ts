import type { z } from 'zod'
import { FederationAttachStartParams } from '../../../../../../shared/rpc-contract/orchestration-federation-start-params'
export { FederationAttachStartParams }

export type FederationAttachStartInput = z.infer<typeof FederationAttachStartParams>
