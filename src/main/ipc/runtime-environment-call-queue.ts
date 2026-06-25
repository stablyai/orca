import { RuntimeRpcCallQueuePool } from '../../shared/runtime-rpc-call-queue'

const runtimeCallQueuePool = new RuntimeRpcCallQueuePool()

export function enqueueRuntimeCall<T>(
  selector: string,
  method: string,
  run: () => Promise<T>,
  options?: { background?: boolean }
): Promise<T> {
  return runtimeCallQueuePool.enqueue(selector, method, run, options)
}
