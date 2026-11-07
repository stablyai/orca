import {
  limitRemoteRuntimeRequestDispatch,
  remoteRuntimeRequestDispatchExpiredError
} from '../../../shared/remote-runtime/requests/remote-runtime-request-dispatch-observation'
import { MAX_TIMER_DELAY_MS } from '../../../shared/timer-delay'

const GENERATED_INPUT_METHODS = new Set(['terminal.sendGeneratedInput', 'terminal.send'])

/** A generated request's dispatch, from main's acceptance of it to its frame's actual handoff,
 *  bounded by the end its renderer accepted it with (this machine's clock). Until the handoff,
 *  `signal` ends its queued and preparing work at that end; at the handoff the frame carries only
 *  the time left, and from then on the end no longer cuts the host's answer. */
export type GeneratedInputDispatch = {
  signal: AbortSignal
  expired: () => boolean
  dispose: () => void
}

export function generatedInputDispatch(
  method: string,
  params: unknown,
  end: unknown
): GeneratedInputDispatch | null {
  if (!GENERATED_INPUT_METHODS.has(method) || typeof end !== 'number' || !Number.isFinite(end)) {
    return null
  }
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(remoteRuntimeRequestDispatchExpiredError()),
    Math.min(MAX_TIMER_DELAY_MS, Math.max(0, end - Date.now()))
  )
  timer.unref?.()
  const dispose = (): void => clearTimeout(timer)
  limitRemoteRuntimeRequestDispatch(params, {
    end,
    // An older host's terminal.send carries no budget; a generated request carries what is left.
    ...(method === 'terminal.sendGeneratedInput'
      ? {
          withRemaining: (sent: unknown, remainingMs: number) =>
            Object.assign({}, sent, {
              timeoutMs: Math.min(budgetOf(sent) ?? remainingMs, remainingMs)
            })
        }
      : {}),
    handedOff: dispose
  })
  return { signal: controller.signal, expired: () => Date.now() >= end, dispose }
}

function budgetOf(params: unknown): number | undefined {
  const budget =
    typeof params === 'object' && params !== null ? Reflect.get(params, 'timeoutMs') : undefined
  return typeof budget === 'number' ? budget : undefined
}
