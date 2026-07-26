import { RuntimeRpcCallQueuePool } from '../../shared/runtime-rpc-call-queue'

const runtimeCallQueuePool = new RuntimeRpcCallQueuePool()

export function enqueueRuntimeCall<T>(
  selector: string,
  method: string,
  run: () => Promise<T>,
  retainedBytes = 0
): Promise<T> {
  return runtimeCallQueuePool.enqueue(selector, method, run, retainedBytes)
}
