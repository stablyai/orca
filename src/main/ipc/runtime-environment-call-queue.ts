import { RuntimeRpcCallQueuePool } from '../../shared/runtime-rpc-call-queue'
import type { RuntimeOrchestrationEnvelope } from '../../shared/runtime-rpc-envelope'

const runtimeCallQueuePool = new RuntimeRpcCallQueuePool()

export function enqueueRuntimeCall<T>(
  selector: string,
  method: string,
  params: unknown,
  run: (params: unknown, envelope?: RuntimeOrchestrationEnvelope) => Promise<T>,
  signal?: AbortSignal,
  envelope?: RuntimeOrchestrationEnvelope
): Promise<T> {
  return runtimeCallQueuePool.enqueueJson(selector, method, params, run, signal, envelope)
}
