import { useEffect, useState } from 'react'
import type { RpcClient } from './rpc-client'
import type { ConnectionState } from './types'
import { hostStatusProbe, readHostStatusGates } from './host-status-probe-operations'
import { evaluateCompat, type CompatVerdict } from './protocol-compat'
import type { HostStatusReply } from './host-status-reply-schema'
import { normalizeHostAppVersion } from './host-app-version'
import { recordHostAppVersion } from './host-app-version-store'
import { recordHostDescriptorFromStatus } from './host-descriptor-recorder'

export type HostStatusGates = {
  hostCapabilities: string[]
  floatingWorkspaceEnabled: boolean
  desktopAppVersion: string | null
  compatVerdict: CompatVerdict
  /** The two protocol numbers the status carried, for callers that evaluate a compat window this
   *  hook does not own — the mobile web bundle's. Kept as the reply's own fields rather than a
   *  restated shape so a rename upstream is a build error here. */
  hostProtocolWindow: HostProtocolWindow
  statusPending: boolean
  /** Whether the settled answer came from a status this host actually returned and this client
   *  could decode. Both failure paths below settle the same closed gates an old host with no
   *  capabilities would produce, so without this a caller cannot tell "this desktop does not have
   *  the feature" from "nobody answered" — and the mobile web shell's wall is terminal, so it must
   *  never be shown for the second. */
  statusReadable: boolean
}

// statusPending is not stored: pending-ness belongs to the live connection, not to the answer.
type LoadedHostStatusGates = Omit<HostStatusGates, 'statusPending'> & {
  hostId: string | undefined
  client: RpcClient
}

export type HostProtocolWindow = Pick<
  HostStatusReply,
  'protocolVersion' | 'minCompatibleMobileVersion'
>

const EMPTY_HOST_CAPABILITIES: string[] = []
// Stable identities: consumers compare gates by reference to decide whether to re-run a step.
// Both keys stated: the reply schema salvages them as present-and-possibly-undefined, and
// `evaluateMobileWebBundleCompat` reads an absent number as "oldest host" and "no floor".
const EMPTY_HOST_PROTOCOL_WINDOW: HostProtocolWindow = {
  protocolVersion: undefined,
  minCompatibleMobileVersion: undefined
}

// Reads status.get on connect for capabilities, protocol-compat verdict, and the
// floating-workspace flag. Compat constants are wide-open today so this never blocks yet.
export function useHostStatusGates(args: {
  hostId: string | undefined
  client: RpcClient | null
  connState: ConnectionState
}): HostStatusGates {
  const { hostId, client, connState } = args
  const [loaded, setLoaded] = useState<LoadedHostStatusGates | null>(null)
  // Why (F10): a drop must not erase proven capabilities, but it does invalidate them — this keeps
  // statusPending true across the reconnect refetch, so gates stay "unknown" while the data survives.
  const [unverified, setUnverified] = useState(false)

  useEffect(() => {
    if (connState !== 'connected' || !client) {
      setUnverified(true)
      return
    }
    let cancelled = false
    const requestClient = client
    const settle = (gates: Omit<HostStatusGates, 'statusPending'>) => {
      setLoaded({ hostId, client: requestClient, ...gates })
      setUnverified(false)
    }
    void (async () => {
      try {
        const reply = await hostStatusProbe.request(requestClient)
        if (cancelled) {
          return
        }
        const status = readHostStatusGates(reply)
        if (!status) {
          settle({
            hostCapabilities: [],
            floatingWorkspaceEnabled: false,
            desktopAppVersion: null,
            compatVerdict: { kind: 'ok' },
            hostProtocolWindow: EMPTY_HOST_PROTOCOL_WINDOW,
            statusReadable: false
          })
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
          // Why also here: the web page never runs the connection layer's probe, and the host
          // screen should not wait for it; the recorder is idempotent across the two feeds.
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
      } catch {
        // Why: a transient status failure must not trap navigation; conservative feature gates remain disabled.
        if (!cancelled) {
          settle({
            hostCapabilities: [],
            floatingWorkspaceEnabled: false,
            desktopAppVersion: null,
            compatVerdict: { kind: 'ok' },
            hostProtocolWindow: EMPTY_HOST_PROTOCOL_WINDOW,
            statusReadable: false
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, connState, hostId])

  // Why: effects run after render, so key loaded gates by host and client to fail closed during route reuse.
  const proven = loaded && loaded.hostId === hostId && loaded.client === client ? loaded : null
  if (!proven) {
    return {
      hostCapabilities: EMPTY_HOST_CAPABILITIES,
      floatingWorkspaceEnabled: false,
      desktopAppVersion: null,
      compatVerdict: { kind: 'ok' },
      hostProtocolWindow: EMPTY_HOST_PROTOCOL_WINDOW,
      statusPending: connState === 'connected' && client !== null,
      statusReadable: false
    }
  }
  return {
    hostCapabilities: proven.hostCapabilities,
    floatingWorkspaceEnabled: proven.floatingWorkspaceEnabled,
    desktopAppVersion: proven.desktopAppVersion,
    compatVerdict: proven.compatVerdict,
    hostProtocolWindow: proven.hostProtocolWindow,
    statusReadable: proven.statusReadable,
    // Why (F10): unchanged pending timing — the reconnect refetch is still "unknown", it just no
    // longer blanks the capabilities this same host already proved.
    statusPending: connState === 'connected' && unverified
  }
}
