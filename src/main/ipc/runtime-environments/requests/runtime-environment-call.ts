import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRequestGuard,
  RuntimeRequestPreparation
} from '../../../../shared/runtime-rpc-envelope'

/** One RPC as the runtime-environment routes send it, whichever socket carries it. */
export type RuntimeEnvironmentCall = {
  method: string
  params: unknown
  timeoutMs: number
  envelope?: RuntimeOrchestrationEnvelope
  signal?: AbortSignal
  prepareRequest?: RuntimeRequestPreparation
  prepareGuard?: RuntimeRequestGuard
}
