import { isTerminalChatPromptCall } from '../../../shared/terminal/input/terminal-chat-prompt-call'

/** An internal signal expires only this one-shot request, including account preparation and queues. */
export async function withTerminalChatCallDeadline<T>(
  call: { method: string; params?: unknown; timeoutMs?: number },
  run: (signal?: AbortSignal) => Promise<T>
): Promise<T> {
  if (!isTerminalChatPromptCall(call.method, call.params)) {
    return run()
  }
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error('Chat input request expired')),
    Math.max(1, Math.min(call.timeoutMs ?? 65_000, 65_000))
  )
  timer.unref?.()
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

export function terminalChatTransportTimeoutMs(
  method: string,
  params: unknown,
  requested?: number
): number {
  return isTerminalChatPromptCall(method, params)
    ? Math.max(65_000, requested ?? 65_000)
    : (requested ?? 15_000)
}
