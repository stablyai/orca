import type { RpcClient } from './rpc-client'
import type { RpcSuccess } from './types'
import { isLogicalClientCutoverError } from './stable-logical-rpc-client'

// Why: a relay→direct cutover or request timeout can reject an in-flight
// status.get without ever changing connState, so a one-shot probe would latch
// capability-gated UI hidden until the screen remounts; retry until one lands.
const CUTOVER_RETRY_DELAY_MS = 250
// Why a cap: a link that keeps forcing cutovers would otherwise poll status.get four times a second
// for as long as the screen is mounted. After the prompt attempts, cutovers join the backoff ladder.
const CUTOVER_FAST_RETRY_LIMIT = 3
const FAILURE_RETRY_BASE_DELAY_MS = 1_000
const FAILURE_RETRY_MAX_DELAY_MS = 15_000

export function startRuntimeCapabilityProbe(
  client: RpcClient,
  onCapabilities: (capabilities: readonly string[]) => void
): () => void {
  return startRuntimeCapabilityRead(async () => {
    const response = await client.sendRequest('status.get')
    if (!response.ok) {
      throw new Error('runtime_capability_probe_failed')
    }
    return parseRuntimeStatusCapabilities((response as RpcSuccess).result) ?? []
  }, onCapabilities)
}

export function parseRuntimeStatusCapabilities(result: unknown): string[] | null {
  if (!result || typeof result !== 'object') {
    return null
  }
  const capabilities = (result as { capabilities?: unknown }).capabilities
  if (capabilities === undefined) {
    return []
  }
  return Array.isArray(capabilities) &&
    capabilities.every((capability) => typeof capability === 'string')
    ? capabilities
    : null
}

export function startRuntimeCapabilityRead<T>(
  readCapabilities: () => Promise<T>,
  onCapabilities: (capabilities: T) => void
): () => void {
  let cancelled = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let failureRetries = 0
  let cutoverRetries = 0

  function attempt(): void {
    void readCapabilities().then(
      (capabilities) => {
        if (cancelled) {
          return
        }
        onCapabilities(capabilities)
      },
      (error: unknown) => {
        if (cancelled) {
          return
        }
        scheduleRetry(isLogicalClientCutoverError(error))
      }
    )
  }

  function scheduleRetry(cutover: boolean): void {
    // Why: cutover means the replacement transport is already authenticated —
    // re-ask promptly; other failures back off so a wedged host isn't hammered.
    const delay =
      cutover && cutoverRetries++ < CUTOVER_FAST_RETRY_LIMIT
        ? CUTOVER_RETRY_DELAY_MS
        : Math.min(FAILURE_RETRY_BASE_DELAY_MS * 2 ** failureRetries++, FAILURE_RETRY_MAX_DELAY_MS)
    retryTimer = setTimeout(attempt, delay)
  }

  attempt()
  return () => {
    cancelled = true
    if (retryTimer) {
      clearTimeout(retryTimer)
    }
  }
}
