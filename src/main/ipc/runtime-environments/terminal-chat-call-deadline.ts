import { isTerminalChatPromptCall } from '../../../shared/terminal/input/terminal-chat-prompt-call'
import { TerminalChatPromptParam } from '../../../shared/rpc-contract/terminal-chat-prompt-params'
import { readRuntimeElapsedClock } from '../../runtime/hosts/runtime-elapsed-clock'
import { terminalChatPromptSchedule } from '../../../shared/terminal/input/terminal-chat-prompt-budget'

type ChatCall = { method: string; params?: unknown; timeoutMs?: number }

export type TerminalChatCallBudget = Readonly<{
  prompt: NonNullable<ReturnType<typeof TerminalChatPromptParam.parse>>
  originRuntimeId?: string
  schedule: ReturnType<typeof terminalChatPromptSchedule>
}>

export function terminalChatCallBudget(
  call: ChatCall,
  originRuntimeId?: string
): TerminalChatCallBudget | undefined {
  if (!isTerminalChatPromptCall(call.method, call.params)) {
    return undefined
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the preceding Chat classification proves this nested field exists.
  const params = call.params as { chatPrompt: unknown }
  const prompt = TerminalChatPromptParam.parse(params.chatPrompt)
  return prompt
    ? { prompt, originRuntimeId, schedule: terminalChatPromptSchedule(prompt.text) }
    : undefined
}

export function assertTerminalChatCallCurrent(
  budget: TerminalChatCallBudget | undefined,
  runtimeId = budget?.originRuntimeId
): number | undefined {
  if (!budget?.prompt.expiry) {
    return undefined
  }
  const expiry = budget.prompt.expiry
  const now = readRuntimeElapsedClock()
  if (
    !now ||
    expiry.runtimeId !== runtimeId ||
    expiry.expiresAtMs <= now.upper ||
    expiry.expiresAtMs - now.lower > budget.schedule.lifetimeMs
  ) {
    throw new Error('Chat input request expired')
  }
  return expiry.expiresAtMs - now.upper
}

/** An internal signal expires only this operation, including preparation and IPC delay. */
export async function withTerminalChatCallDeadline<T>(
  call: ChatCall,
  run: (signal?: AbortSignal, budget?: TerminalChatCallBudget) => Promise<T>,
  runtimeId?: string
): Promise<T> {
  if (!isTerminalChatPromptCall(call.method, call.params)) {
    return run()
  }
  const budget = terminalChatCallBudget(call, runtimeId)
  const remaining = assertTerminalChatCallCurrent(budget, runtimeId)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout>
  const wake = (): void => {
    try {
      const left = remaining === undefined ? 0 : assertTerminalChatCallCurrent(budget, runtimeId)!
      if (left > 0) {
        timer = setTimeout(wake, left)
        timer.unref?.()
        return
      }
    } catch {
      /* The elapsed grant ended or its clock became unavailable. */
    }
    controller.abort(new Error('Chat input request expired'))
  }
  timer = setTimeout(wake, remaining ?? Math.max(1, Math.min(call.timeoutMs ?? 65_000, 65_000)))
  timer.unref?.()
  try {
    return await run(controller.signal, budget)
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
