import { RuntimeRpcCallQueuePool } from '../../shared/runtime-rpc-call-queue'

const runtimeCallQueuePool = new RuntimeRpcCallQueuePool()

export function enqueueRuntimeCall<T>(
  selector: string,
  method: string,
  run: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  return runtimeCallQueuePool.enqueue(selector, method, run, 0, signal)
}
