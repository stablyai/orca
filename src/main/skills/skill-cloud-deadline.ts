const DEFAULT_SKILL_CLOUD_TIMEOUT_MS = 60_000

export function createSkillCloudDeadline(input: {
  signal?: AbortSignal
  timeoutMs?: number
  timeoutMessage: string
}): {
  signal: AbortSignal
  cleanup(): void
} {
  const timeoutMs = input.timeoutMs ?? DEFAULT_SKILL_CLOUD_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`${input.timeoutMessage}-invalid`)
  }
  const controller = new AbortController()
  const forwardAbort = (): void => controller.abort(input.signal?.reason)
  if (input.signal?.aborted) {
    forwardAbort()
  } else {
    input.signal?.addEventListener('abort', forwardAbort, { once: true })
  }
  const timeout = setTimeout(() => controller.abort(new Error(input.timeoutMessage)), timeoutMs)
  timeout.unref()
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout)
      input.signal?.removeEventListener('abort', forwardAbort)
    }
  }
}
