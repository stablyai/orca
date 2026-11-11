import { PROJECT_REPO_FILTER_EXACT_CAPABILITY } from '../../../../src/shared/project-repo-filter-capability'
import { AppState } from 'react-native'
import { useEffect, useMemo, useState } from 'react'
import type { RpcClient } from '../rpc/rpc-client-contract'
import type { ConnectionState } from './connection-state'
import { evaluateCompat, type CompatVerdict } from './protocol-compat'
import { hostStatusSchema, type HostStatusReply } from '../hosts/host-status-reply-schema'
import { normalizeHostAppVersion } from '../../host-descriptors/host-app-version'
import { recordHostAppVersion } from '../../host-descriptors/host-app-version-store'
import { recordHostDescriptorFromStatus } from '../../host-descriptors/host-descriptor-recorder'
import { readConnectionStatusProbe, startRuntimeStatusProbe } from './runtime-status-probe'

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
  /** The host's store identity, which cross-store parent records name; absent when unknown. */
  hostInstallationId?: string
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

/** What a readable status means to this client: the verdict is this build's own window check. */
export function hostStatusGatesFromStatus(
  status: HostStatusReply
): Omit<HostStatusGates, 'statusPending'> {
  return {
    hostCapabilities: status.capabilities ?? [],
    floatingWorkspaceEnabled: status.floatingWorkspaceEnabled === true,
    desktopAppVersion: normalizeHostAppVersion(status.appVersion),
    compatVerdict: evaluateCompat({
      desktopProtocolVersion: status.protocolVersion,
      desktopMinCompatibleMobileVersion: status.minCompatibleMobileVersion
    }),
    hostProtocolWindow: {
      protocolVersion: status.protocolVersion,
      minCompatibleMobileVersion: status.minCompatibleMobileVersion
    },
    statusReadable: true,
    ...(status.hostDescriptor?.installationId
      ? { hostInstallationId: status.hostDescriptor.installationId }
      : {})
  }
}

// Keyed by the cached answer so a connection's proven gates keep one identity across renders.
const gatesByProbedStatus = new WeakMap<HostStatusReply, HostStatusGates>()

// Draw at once from the status this connection already proved; the gate's own read still refreshes live capabilities.
function readProbedGates(
  client: RpcClient | null,
  connState: ConnectionState
): HostStatusGates | null {
  const status = client && connState === 'connected' ? readConnectionStatusProbe(client) : undefined
  if (!status) {
    return null
  }
  let gates = gatesByProbedStatus.get(status)
  if (!gates) {
    const exact = status.capabilities?.includes(PROJECT_REPO_FILTER_EXACT_CAPABILITY) === true
    gates = {
      ...hostStatusGatesFromStatus(status),
      statusGeneration: client?.getGeneration?.(),
      exactProjectRepoFilters: exact,
      projectRepoFilterSupport: exact ? 'exact' : 'legacy',
      statusPending: false
    }
    gatesByProbedStatus.set(status, gates)
  }
  return gates
}

export function useHostStatusGates(args: {
  hostId: string | undefined
  client: RpcClient | null
  connState: ConnectionState
}): HostStatusGates {
  const { hostId, client, connState } = args
  const [loaded, setLoaded] = useState<LoadedHostStatusGates | null>(null)
  // A page starts from the status its shell already proved, so its first mount skips a round trip.
  const shellStatus = client?.getShellHostStatus?.() ?? null
  const seeded = useMemo(() => {
    const status = shellStatus === null ? null : hostStatusSchema.safeParse(shellStatus)
    return status?.success ? hostStatusGatesFromStatus(status.data) : null
  }, [shellStatus])
  // Keep proven capabilities across drops while marking them unverified until the reconnect read settles.
  const [unverified, setUnverified] = useState(false)

  // Mark during render; only a settled read clears it, and no read runs while disconnected.
  if ((connState !== 'connected' || !client) && !unverified) {
    setUnverified(true)
  }

  useEffect(() => {
    if (!client) {
      return
    }
    let probe: ReturnType<typeof startHostStatusRead> | null = null
    let generation = client.getGeneration?.()
    let firstRead = true
    let epoch = 0
    const read = () => {
      const connected = connState === 'connected' && client.getState() === 'connected'
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
      if (!firstRead || !seeded) {
        setUnverified(true)
      }
      firstRead = false
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
  }, [client, connState, hostId, seeded])

  const probed = readProbedGates(client, connState)
  if (probed) {
    return probed
  }
  // Why: effects run after render, so key loaded gates by host and client to fail closed during route reuse.
  const proven =
    loaded &&
    loaded.hostId === hostId &&
    loaded.client === client &&
    loaded.generation === client?.getGeneration?.()
      ? loaded
      : null
  // The seed stands only for the connection the shell proved it on; after a drop the page reads again.
  if (!proven && seeded && !unverified && connState === 'connected' && client !== null) {
    return {
      ...seeded,
      statusGeneration: client.getGeneration?.(),
      exactProjectRepoFilters: seeded.hostCapabilities.includes(
        PROJECT_REPO_FILTER_EXACT_CAPABILITY
      ),
      projectRepoFilterSupport: seeded.hostCapabilities.includes(
        PROJECT_REPO_FILTER_EXACT_CAPABILITY
      )
        ? 'exact'
        : 'legacy',
      statusPending: false
    }
  }
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
    statusPending: connState === 'connected' && unverified,
    ...(proven.hostInstallationId ? { hostInstallationId: proven.hostInstallationId } : {})
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
      const gates = hostStatusGatesFromStatus(status)
      const { compatVerdict: verdict, desktopAppVersion } = gates
      if (hostId && desktopAppVersion) {
        void recordHostAppVersion(hostId, desktopAppVersion)
      }
      if (hostId) {
        // Record here too because pages lack the connection-layer probe; the recorder tolerates duplicate feeds.
        recordHostDescriptorFromStatus(hostId, status)
      }
      settle(gates)
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
