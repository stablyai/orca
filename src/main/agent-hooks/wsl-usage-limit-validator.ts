import {
  TERMINAL_USAGE_LIMIT_SOURCE_METHOD,
  type TerminalUsageLimitSourceRequest,
  type TerminalUsageLimitSourceResult
} from '../../shared/terminal-usage-limit-source-validation'
import {
  wslHookRelayConnectionId,
  WSL_HOOK_RELAY_CONNECTION_PREFIX
} from '../../shared/wsl-hook-relay-contract'
import { wslHookRelayStateKey } from './wsl-hook-relay-state-key'
import type { WslRelayDistroState } from './wsl-hook-relay-state'

export function captureWslUsageLimitValidator(
  connectionId: string,
  states: ReadonlyMap<string, WslRelayDistroState>,
  isAllowed: () => boolean
) {
  if (!connectionId.startsWith(WSL_HOOK_RELAY_CONNECTION_PREFIX)) {
    return null
  }
  const distro = connectionId.slice(WSL_HOOK_RELAY_CONNECTION_PREFIX.length)
  const state = states.get(wslHookRelayStateKey(distro))
  const mux = state?.mux
  if (!state || !mux || wslHookRelayConnectionId(state.distro) !== connectionId) {
    return null
  }
  const isCurrent = () =>
    isAllowed() &&
    states.get(wslHookRelayStateKey(distro)) === state &&
    state.phase === 'running' &&
    state.mux === mux &&
    !mux.isDisposed()
  if (!isCurrent()) {
    return null
  }
  return {
    isCurrent,
    validateSource: async (
      request: TerminalUsageLimitSourceRequest,
      signal?: AbortSignal
    ): Promise<TerminalUsageLimitSourceResult> => {
      if (!isCurrent()) {
        return { status: 'unavailable' }
      }
      try {
        const result = await mux.request(TERMINAL_USAGE_LIMIT_SOURCE_METHOD, request, {
          timeoutMs: 1000,
          signal
        })
        if (!isCurrent()) {
          return { status: 'changed' }
        }
        if (
          typeof result === 'object' &&
          result !== null &&
          'status' in result &&
          (result.status === 'current' ||
            result.status === 'changed' ||
            result.status === 'unavailable')
        ) {
          return { status: result.status }
        }
      } catch {
        // An older or lost guest leaves ordinary terminal input available.
      }
      return { status: 'unavailable' }
    }
  }
}
