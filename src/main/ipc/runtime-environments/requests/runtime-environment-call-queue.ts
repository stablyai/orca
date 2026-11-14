import { RuntimeRpcCallQueuePool } from '../../../../shared/runtime-rpc-call-queue'

export const runtimeCallQueuePool = new RuntimeRpcCallQueuePool()

export function enqueueRuntimeCall<T>(
  selector: string,
  method: string,
  run: () => Promise<T>,
  signal?: AbortSignal,
  params?: unknown
): Promise<T> {
  return runtimeCallQueuePool.enqueue(selector, method, run, 0, signal, params)
}
