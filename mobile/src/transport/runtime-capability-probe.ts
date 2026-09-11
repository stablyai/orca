import type { RpcClient } from './rpc-client'
import type { RpcSuccess } from './types'
import { isLogicalClientCutoverError } from './stable-logical-rpc-client'

// Why: a relay→direct cutover or request timeout can reject an in-flight
// status.get without ever changing connState, so a one-shot probe would latch
// capability-gated UI hidden until the screen remounts; retry until one lands.
const CUTOVER_RETRY_DELAY_MS = 250
const FAILURE_RETRY_BASE_DELAY_MS = 1_000
const FAILURE_RETRY_MAX_DELAY_MS = 15_000

// An attempt is `settled` only when the host gave an answer worth pinning; anything
// else is an absence of contact, which must never become a durable verdict.
export type SettlingProbeAttempt<T> =
  | { settled: true; result: T }
  | { settled: false; cutover: boolean }

// `attempt` must resolve rather than reject — classify the failure into the union.
// `deferFirstAttempt` is for callers that already hold an unsettled answer, so the
// driver backs off before re-asking instead of doubling the request immediately.
export function startSettlingStatusProbe<T>(
  attempt: () => Promise<SettlingProbeAttempt<T>>,
  onSettled: (result: T) => void,
  options?: { readonly deferFirstAttempt?: boolean }
): () => void {
  let cancelled = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let failureRetries = 0

  function run(): void {
    void attempt().then((outcome) => {
      if (cancelled) {
        return
      }
      if (!outcome.settled) {
        scheduleRetry(outcome.cutover)
        return
      }
      onSettled(outcome.result)
    })
  }

  function scheduleRetry(cutover: boolean): void {
    // Why: cutover means the replacement transport is already authenticated —
    // re-ask promptly; other failures back off so a wedged host isn't hammered.
    const delay = cutover
      ? CUTOVER_RETRY_DELAY_MS
      : Math.min(FAILURE_RETRY_BASE_DELAY_MS * 2 ** failureRetries++, FAILURE_RETRY_MAX_DELAY_MS)
    retryTimer = setTimeout(run, delay)
  }

  if (options?.deferFirstAttempt) {
    scheduleRetry(false)
  } else {
    run()
  }
  return () => {
    cancelled = true
    if (retryTimer) {
      clearTimeout(retryTimer)
    }
  }
}

export function startRuntimeCapabilityProbe(
  client: RpcClient,
  onCapabilities: (capabilities: readonly string[]) => void
): () => void {
  return startSettlingStatusProbe(() => readStatusCapabilities(client), onCapabilities)
}

async function readStatusCapabilities(
  client: RpcClient
): Promise<SettlingProbeAttempt<readonly string[]>> {
  try {
    const response = await client.sendRequest('status.get')
    if (!response.ok) {
      return { settled: false, cutover: false }
    }
    const result = (response as RpcSuccess).result
    const rawCapabilities =
      result && typeof result === 'object'
        ? (result as { capabilities?: unknown }).capabilities
        : null
    const capabilities =
      Array.isArray(rawCapabilities) && rawCapabilities.every((value) => typeof value === 'string')
        ? rawCapabilities
        : []
    return { settled: true, result: capabilities }
  } catch (error) {
    return { settled: false, cutover: isLogicalClientCutoverError(error) }
  }
}
