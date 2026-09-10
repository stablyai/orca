import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { RpcClient } from './rpc-client'
import type { ConnectionState } from './types'
import type { DesktopStatus } from '../worktree/host-worktree-rpc-types'
import { readHostProtocolVerdict, type CompatVerdict } from './protocol-compat'
import { normalizeHostAppVersion, recordHostAppVersion } from './host-app-version-store'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'

export type HostStatusGates = {
  hostCapabilities: string[]
  floatingWorkspaceEnabled: boolean
  desktopAppVersion: string | null
  compatVerdict: CompatVerdict
  statusPending: boolean
  retryStatus: () => void
}

type LoadedHostStatusGates = Omit<HostStatusGates, 'statusPending' | 'retryStatus'> & {
  hostId: string | undefined
  client: RpcClient
  generation: number
}

const EMPTY_HOST_CAPABILITIES: string[] = []
const STATUS_RETRY_DELAYS = [1_000, 2_000, 4_000]
// Covers the connect wait too: without budgetSpansConnect the wait gets its own full
// timeoutMs, so an attempt can run to twice this before the retry backoff even starts.
export const HOST_STATUS_REQUEST_TIMEOUT_MS = 8_000

export function useHostStatusGates(args: {
  hostId: string | undefined
  client: RpcClient | null
  connState: ConnectionState
}): HostStatusGates {
  const { hostId, client, connState } = args
  const [loaded, setLoaded] = useState<LoadedHostStatusGates | null>(null)
  const [unverified, setUnverified] = useState(false)
  const [retry, setRetry] = useState(0)
  const retryStatus = useCallback(() => setRetry((value) => value + 1), [])
  // Mirrors `loaded` for the effect, which must read it without re-running on every answer.
  const loadedRef = useRef<LoadedHostStatusGates | null>(null)
  const applyLoaded = useCallback((next: LoadedHostStatusGates) => {
    loadedRef.current = next
    setLoaded(next)
  }, [])
  const readGeneration = useCallback(
    () => (client as Partial<StableLogicalRpcClient> | null)?.getGeneration?.() ?? 0,
    [client]
  )
  const subscribeGeneration = useCallback(
    (listener: () => void) => client?.onStateChange?.(listener) ?? (() => {}),
    [client]
  )
  const generation = useSyncExternalStore(subscribeGeneration, readGeneration, readGeneration)

  useEffect(() => {
    if (connState !== 'connected' || !client) {
      setUnverified(true)
      return
    }
    let cancelled = false
    let cancelRetry = () => {}
    let attempt = 0
    const settleUnknown = () => {
      if (cancelled || generation !== readGeneration()) {
        return
      }
      const delay = STATUS_RETRY_DELAYS[attempt++]
      const previous = loadedRef.current
      const sameGeneration =
        previous !== null &&
        previous.hostId === hostId &&
        previous.client === client &&
        previous.generation === generation
      // Why: a probe with retries left is still pending, so a hiccup shows the spinner rather
      // than a card the user cannot dismiss. Only an exhausted ladder settles and offers Retry.
      // Restores the memory main had in the gate's resolved-host latch.
      setUnverified(delay !== undefined)
      // Why: a verdict this generation already proved outranks the failure; only a generation
      // with no record of its own falls back to unknown.
      if (!sameGeneration) {
        applyLoaded({
          hostId,
          client,
          generation,
          hostCapabilities: EMPTY_HOST_CAPABILITIES,
          floatingWorkspaceEnabled: false,
          desktopAppVersion: null,
          compatVerdict: { kind: 'unknown' }
        })
      }
      if (delay !== undefined) {
        cancelRetry = scheduleHostStatusRetry(() => void probe(), delay)
      }
    }
    const probe = async () => {
      if (cancelled || generation !== readGeneration()) {
        return
      }
      setUnverified(true)
      try {
        const response = await client.sendRequest('status.get', undefined, {
          timeoutMs: HOST_STATUS_REQUEST_TIMEOUT_MS,
          budgetSpansConnect: true
        })
        if (cancelled || generation !== readGeneration()) {
          return
        }
        const verdict = response.ok
          ? readHostProtocolVerdict(response.result)
          : { kind: 'unknown' as const }
        if (verdict.kind === 'unknown' || !response.ok) {
          settleUnknown()
          return
        }
        const status = response.result as DesktopStatus & { capabilities?: string[] }
        const desktopAppVersion = normalizeHostAppVersion(status.appVersion)
        if (hostId && desktopAppVersion) {
          void recordHostAppVersion(hostId, desktopAppVersion)
        }
        applyLoaded({
          hostId,
          client,
          generation,
          hostCapabilities: status.capabilities ?? EMPTY_HOST_CAPABILITIES,
          floatingWorkspaceEnabled: status.floatingWorkspaceEnabled === true,
          desktopAppVersion,
          compatVerdict: verdict
        })
        setUnverified(false)
        if (verdict.kind === 'blocked') {
          console.warn('[protocol-compat] blocked', {
            reason: verdict.reason,
            desktopVersion: verdict.desktopVersion,
            requiredMobileVersion: verdict.requiredMobileVersion,
            requiredDesktopVersion: verdict.requiredDesktopVersion
          })
        }
      } catch {
        settleUnknown()
      }
    }
    void probe()
    return () => {
      cancelled = true
      cancelRetry()
    }
  }, [client, connState, hostId, generation, readGeneration, retry, applyLoaded])

  // A logical client survives cutover; its generation fences even a same-host late reply.
  const proven =
    loaded &&
    loaded.hostId === hostId &&
    loaded.client === client &&
    loaded.generation === generation
      ? loaded
      : null
  if (!proven) {
    return {
      hostCapabilities: EMPTY_HOST_CAPABILITIES,
      floatingWorkspaceEnabled: false,
      desktopAppVersion: null,
      compatVerdict: { kind: 'unknown' },
      statusPending: connState === 'connected' && client !== null,
      retryStatus
    }
  }
  return {
    hostCapabilities: proven.hostCapabilities,
    floatingWorkspaceEnabled: proven.floatingWorkspaceEnabled,
    desktopAppVersion: proven.desktopAppVersion,
    compatVerdict: proven.compatVerdict,
    // Proven capabilities and navigation survive a transient same-generation reconnect.
    statusPending: connState === 'connected' && unverified,
    retryStatus
  }
}

function scheduleHostStatusRetry(probe: () => void, delay: number): () => void {
  const timer = setTimeout(probe, delay)
  return () => clearTimeout(timer)
}
