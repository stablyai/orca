import { isTerminalChatPromptCall } from '../../../../shared/terminal/input/terminal-chat-prompt-call'
import { RuntimeRpcCallQueuePool } from '../../../../shared/runtime-rpc-call-queue'

const runtimeCallQueuePool = new RuntimeRpcCallQueuePool()

export function enqueueRuntimeCall<T>(
  selector: string,
  method: string,
  run: () => Promise<T>,
  signal?: AbortSignal,
  params?: unknown
): Promise<T> {
  const chat = isTerminalChatPromptCall(method, params)
  return runtimeCallQueuePool.enqueue(
    selector,
    method,
    run,
    chat ? Buffer.byteLength(JSON.stringify(params)) : 0,
    signal,
    chat ? 'chat-prompt' : undefined
  )
}
