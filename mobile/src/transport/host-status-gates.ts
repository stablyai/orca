import { PROJECT_REPO_FILTER_EXACT_CAPABILITY } from '../../../src/shared/project-repo-filter-capability'
import { AppState } from 'react-native'
import { useEffect, useState } from 'react'
import type { RpcClient } from './rpc-client'
import type { ConnectionState } from './types'
import { evaluateCompat, type CompatVerdict } from './protocol-compat'
import type { HostStatusReply } from './host-status-reply-schema'
import { normalizeHostAppVersion } from './host-app-version'
import { recordHostAppVersion } from './host-app-version-store'
import { recordHostDescriptorFromStatus } from './host-descriptor-recorder'
import { startRuntimeStatusProbe } from './runtime-status-probe'

export type HostStatusGates = {
  statusGeneration?: number
  exactProjectRepoFilters?: boolean
  projectRepoFilterSupport?: 'unknown' | 'legacy' | 'exact'
  hostCapabilities: string[]
  floatingWorkspaceEnabled: boolean
  desktopAppVersion: string | null
  compatVerdict: CompatVerdict
  // Expose reply protocol fields for consumers with their own compatibility windows.
  hostProtocolWindow: HostProtocolWindow
  statusPending: boolean
  // Distinguish readable old-host status from no usable answer; only the former may justify a terminal compatibility wall.
  statusReadable: boolean
}

// statusPending is not stored: pending-ness belongs to the live connection, not to the answer.
type LoadedHostStatusGates = Omit<HostStatusGates, 'statusPending'> & {
  hostId: string | undefined
  client: RpcClient
  generation: number | undefined
}

export type HostProtocolWindow = Pick<
  HostStatusReply,
  'protocolVersion' | 'minCompatibleMobileVersion'
>

const EMPTY_HOST_CAPABILITIES: string[] = []
// Keep sentinel identity stable for consumers; explicit undefined keys match salvaged reply fields and mean oldest host/no floor.
const EMPTY_HOST_PROTOCOL_WINDOW: HostProtocolWindow = {
  protocolVersion: undefined,
  minCompatibleMobileVersion: undefined
}

const UNREADABLE_STATUS_GATES: Omit<HostStatusGates, 'statusPending'> = {
  hostCapabilities: EMPTY_HOST_CAPABILITIES,
  floatingWorkspaceEnabled: false,
  desktopAppVersion: null,
  compatVerdict: { kind: 'ok' },
  hostProtocolWindow: EMPTY_HOST_PROTOCOL_WINDOW,
  statusReadable: false
}

export function useHostStatusGates(args: {
  hostId: string | undefined
  client: RpcClient | null
  connState: ConnectionState
}): HostStatusGates {
  const { hostId, client, connState } = args
  const [loaded, setLoaded] = useState<LoadedHostStatusGates | null>(null)
  // Keep proven capabilities across drops while marking them unverified until the reconnect read settles.
  const [unverified, setUnverified] = useState(false)

  useEffect(() => {
    if (!client) {
      return
    }
    let probe: ReturnType<typeof startHostStatusRead> | null = null
    let generation: number | undefined
    let epoch = 0
    const read = () => {
      const connected = client.getState() === 'connected'
      const nextGeneration = client.getGeneration?.()
      if (!connected || nextGeneration !== generation) {
        ++epoch
        probe?.()
        probe = null
        setUnverified(true)
      }
      generation = nextGeneration
      if (!connected) {
        return
      }
      if (probe) {
        setUnverified(true)
        probe.wake()
        return
      }
      const currentEpoch = ++epoch
      setUnverified(true)
      probe = startHostStatusRead(client, hostId, (gates) => {
        if (
          epoch !== currentEpoch ||
          client.getState() !== 'connected' ||
          client.getGeneration?.() !== generation
        ) {
          return
        }
        setLoaded({ hostId, client, generation, ...gates })
        setUnverified(false)
      })
    }
    const unsubscribe = client.onStateChange(read)
    const foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        read()
      }
    })
    read()
    return () => {
      ++epoch
      probe?.()
      unsubscribe()
      foreground.remove()
    }
  }, [client, hostId])

  // Why: effects run after render, so key loaded gates by host and client to fail closed during route reuse.
  const proven =
    loaded &&
    loaded.hostId === hostId &&
    loaded.client === client &&
    loaded.generation === client?.getGeneration?.()
      ? loaded
      : null
  if (!proven) {
    return {
      hostCapabilities: EMPTY_HOST_CAPABILITIES,
      floatingWorkspaceEnabled: false,
      desktopAppVersion: null,
      compatVerdict: { kind: 'ok' },
      hostProtocolWindow: EMPTY_HOST_PROTOCOL_WINDOW,
      statusPending: connState === 'connected' && client !== null,
      statusReadable: false,
      exactProjectRepoFilters:
        loaded !== null &&
        loaded.hostId === hostId &&
        loaded.client === client &&
        loaded.hostCapabilities.includes(PROJECT_REPO_FILTER_EXACT_CAPABILITY),
      projectRepoFilterSupport: 'unknown'
    }
  }
  return {
    statusGeneration: proven.generation,
    exactProjectRepoFilters: proven.hostCapabilities.includes(PROJECT_REPO_FILTER_EXACT_CAPABILITY),
    projectRepoFilterSupport:
      connState !== 'connected' || unverified || !proven.statusReadable
        ? 'unknown'
        : proven.hostCapabilities.includes(PROJECT_REPO_FILTER_EXACT_CAPABILITY)
          ? 'exact'
          : 'legacy',
    hostCapabilities: proven.hostCapabilities,
    floatingWorkspaceEnabled: proven.floatingWorkspaceEnabled,
    desktopAppVersion: proven.desktopAppVersion,
    compatVerdict: proven.compatVerdict,
    hostProtocolWindow: proven.hostProtocolWindow,
    statusReadable: proven.statusReadable,
    statusPending: connState === 'connected' && unverified
  }
}

// Settle closed on first failure while the owned probe keeps retrying; return its stop function to React.
function startHostStatusRead(
  client: RpcClient,
  hostId: string | undefined,
  settle: (gates: Omit<HostStatusGates, 'statusPending'>) => void
): ReturnType<typeof startRuntimeStatusProbe> {
  let settledClosed = false
  // Settle conservative gates once so transient failures cannot trap navigation or repeatedly rerender identical state.
  const settleClosed = () => {
    if (!settledClosed) {
      settledClosed = true
      settle(UNREADABLE_STATUS_GATES)
    }
  }
  return startRuntimeStatusProbe(
    client,
    (status) => {
      // A status this app cannot decode reads the same on every retry, so the probe stops on it.
      if (!status) {
        settleClosed()
        return
      }
      const verdict = evaluateCompat({
        desktopProtocolVersion: status.protocolVersion,
        desktopMinCompatibleMobileVersion: status.minCompatibleMobileVersion
      })
      const desktopAppVersion = normalizeHostAppVersion(status.appVersion)
      if (hostId && desktopAppVersion) {
        void recordHostAppVersion(hostId, desktopAppVersion)
      }
      if (hostId) {
        // Record here too because pages lack the connection-layer probe; the recorder tolerates duplicate feeds.
        recordHostDescriptorFromStatus(hostId, status)
      }
      settle({
        hostCapabilities: status.capabilities ?? [],
        floatingWorkspaceEnabled: status.floatingWorkspaceEnabled === true,
        desktopAppVersion,
        compatVerdict: verdict,
        hostProtocolWindow: {
          protocolVersion: status.protocolVersion,
          minCompatibleMobileVersion: status.minCompatibleMobileVersion
        },
        statusReadable: true
      })
      if (verdict.kind === 'blocked') {
        // Why: support breadcrumb to confirm a block fired vs a render bug; no PII, just version ints.
        console.warn('[protocol-compat] blocked', {
          reason: verdict.reason,
          desktopVersion: verdict.desktopVersion,
          requiredMobileVersion: verdict.requiredMobileVersion,
          requiredDesktopVersion: verdict.requiredDesktopVersion
        })
      }
    },
    settleClosed
  )
}
