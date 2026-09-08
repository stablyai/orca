import type { GlobalSettings } from '../../../shared/types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { withBrowserPaneUiRuntimeRpcSource } from '../../../shared/runtime-rpc-feature-interaction-source'
import { RuntimeRpcCallError, unwrapRuntimeRpcResult } from './runtime-rpc-result'
import { ensureRuntimeEnvironmentCompatible } from './runtime-compatibility-cache'

// Why split across 3 files (max-lines budget): runtime-rpc-result.ts has no
// dependency on the rest of this module (RuntimeRpcCallError/
// unwrapRuntimeRpcResult), so runtime-compatibility-cache.ts can depend on
// it without an import cycle back to this file — callRuntimeRpc below still
// calls ensureRuntimeEnvironmentCompatible. Every symbol external callers
// used to import from here is re-exported unchanged, so no call site needs
// to change its import path.
export {
  RuntimeRpcCallError,
  isRuntimeScopeForbiddenError,
  unwrapRuntimeRpcResult
} from './runtime-rpc-result'
export {
  clearRecentRuntimeCompatibilityFailure,
  clearRuntimeCompatibilityCache,
  clearRuntimeCompatibilityCacheForTests,
  markRuntimeEnvironmentCompatible,
  getRuntimeEnvironmentStatus,
  runtimeEnvironmentSupportsCapability,
  assertRuntimeEnvironmentCapability
} from './runtime-compatibility-cache'

export type RuntimeClientTarget = { kind: 'local' } | { kind: 'environment'; environmentId: string }

export function getActiveRuntimeTarget(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): RuntimeClientTarget {
  const environmentId = settings?.activeRuntimeEnvironmentId?.trim()
  if (!environmentId) {
    return { kind: 'local' }
  }
  return { kind: 'environment', environmentId }
}

export function settingsForRuntimeOwner(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  runtimeEnvironmentId: string | null | undefined
): Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined {
  if (runtimeEnvironmentId === null) {
    return { activeRuntimeEnvironmentId: null }
  }
  const ownerId = runtimeEnvironmentId?.trim()
  return ownerId ? { activeRuntimeEnvironmentId: ownerId } : settings
}

export async function callRuntimeRpc<TResult>(
  target: RuntimeClientTarget,
  method: string,
  params?: unknown,
  options: {
    timeoutMs?: number
    suppressFeatureInteraction?: boolean
    reuseRecentCompatibilityFailure?: boolean
  } = {}
): Promise<TResult> {
  if (target.kind === 'environment' && method !== 'status.get') {
    await ensureRuntimeEnvironmentCompatible(target.environmentId, options)
  }
  const nextParams = addFeatureInteractionSource(params, options)
  const response =
    target.kind === 'local'
      ? await window.api.runtime.call({ method, params: nextParams })
      : await window.api.runtimeEnvironments.call({
          selector: target.environmentId,
          method,
          params: nextParams,
          timeoutMs: options.timeoutMs
        })
  return unwrapRuntimeRpcResult<TResult>(response as RuntimeRpcResponse<TResult>)
}

// Why: the desktop path (target.kind === 'local') keeps its existing
// per-channel window.api.* broadcast (e.g. window.api.ephemeralVm.provision)
// unchanged — see FE-SOL-EVM-002 §2/§3 "Không thuộc phạm vi solution này".
// This generic function only ever runs for target.kind === 'environment';
// a caller reaching it with 'local' is a wiring bug, not a runtime case to
// degrade gracefully — surfacing it loudly here is cheaper to debug than a
// promise that never settles.
const SUBSCRIBE_RUNTIME_STREAM_CHANNEL_LOCAL_TARGET_MESSAGE =
  "subscribeRuntimeStreamChannel does not support target.kind === 'local' (desktop) — " +
  'route the desktop path through its existing window.api.* channel-specific method instead.'

/**
 * Generic client for a backend-go `Registry.StreamChannelHandler` channel
 * (registry.go) — one that acks an `invoke` AND opens a push subscription on
 * the same call (e.g. `terminal.subscribe`, and `ephemeralVm.provision` once
 * TASK-BE-EVM-005 ships). Audited before writing this (FE-SOL-EVM-002 §1):
 * `window.api.runtimeEnvironments.subscribe` (backed by WebRuntimeClient/
 * WebSessionClient, both negotiating wscompat's dialectSessionClient — see
 * session_dialect.go) is the existing, working push-by-request-id hook for
 * this dialect; PushEvent.Channel-keyed routing (push_bridge.go's pipePush,
 * rpc-client.ts's `on(channel, handler)`) is dialectNative-only and unused by
 * any current window.api implementation, so this reuses the former rather
 * than adding a second, parallel push mechanism.
 *
 * The subscription's very FIRST response is the `ack`; every response after
 * that is a push event routed to `onEvent`.
 */
export function subscribeRuntimeStreamChannel<TAck, TEvent>(
  target: RuntimeClientTarget,
  method: string,
  params: unknown,
  onEvent: (event: TEvent) => void
): Promise<{ ack: TAck; unsubscribe: () => void }> {
  if (target.kind === 'local') {
    return Promise.reject(new Error(SUBSCRIBE_RUNTIME_STREAM_CHANNEL_LOCAL_TARGET_MESSAGE))
  }
  const environmentId = target.environmentId
  return new Promise((resolve, reject) => {
    let settled = false
    // Why: don't rely solely on the transport reaping the subscription
    // asynchronously — a caller's own unsubscribe() must stop onEvent
    // deliveries immediately, even if a push frame is already in flight when
    // it's called (matches subscribeSharedFileWatch's own `stopped` guard,
    // web-runtime-client.ts).
    let stopped = false
    let handle: { unsubscribe: () => void } | null = null
    const unsubscribe = (): void => {
      if (stopped) {
        return
      }
      stopped = true
      handle?.unsubscribe()
    }

    window.api.runtimeEnvironments
      .subscribe(
        { selector: environmentId, method, params },
        {
          onResponse: (response: RuntimeRpcResponse<unknown>) => {
            if (stopped) {
              return
            }
            if (!response.ok) {
              if (!settled) {
                settled = true
                reject(new RuntimeRpcCallError(response))
              }
              return
            }
            if (!settled) {
              settled = true
              resolve({ ack: response.result as TAck, unsubscribe })
              return
            }
            onEvent(response.result as TEvent)
          },
          onError: (error) => {
            if (!settled) {
              settled = true
              reject(new Error(error.message))
            }
            // Why: an error arriving after the ack has no `onEvent`-shaped
            // slot in this generic contract (only ack/events, no onError) —
            // the connection layer's own onClose still fires so callers see
            // the subscription end, matching subscribeSharedFileWatch's own
            // "swallow late errors, let onClose signal teardown" precedent
            // (web-runtime-client.ts).
          }
        }
      )
      .then((h) => {
        if (stopped) {
          h.unsubscribe()
          return
        }
        handle = h
      })
      .catch((error: unknown) => {
        if (!settled) {
          settled = true
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
  })
}

function addFeatureInteractionSource(
  params: unknown,
  options: { suppressFeatureInteraction?: boolean }
): unknown {
  if (!options.suppressFeatureInteraction) {
    return params
  }
  return withBrowserPaneUiRuntimeRpcSource(params)
}
