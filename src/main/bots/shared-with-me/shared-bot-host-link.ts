// This computer's link to one shared agent's host: the host's paired control connection, reached over
// its share's Relay link with the share's device key (shared-host-keys.ts). Its state follows that
// connection's, as a paired server's status does.
import { getPreferredPairedRuntimeConnection } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { sharedHostEnvironment } from '../../../shared/remote-runtime/pairing/shared-host-keys'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../shared/remote-runtime/control/remote-runtime-shared-control-types'
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { SharedHostLink } from '../../../shared/remote-runtime/relay/client/shared-host-relay-link'
import {
  closeRemoteRuntimeRequestConnection,
  ensureRemoteRuntimeSharedControlConnection,
  getRemoteRuntimeSharedControlDiagnostics,
  reconnectRemoteRuntimeSharedControlConnection,
  sendRemoteRuntimeSharedControlRequest
} from '../../ipc/runtime-environments/connections/runtime-environment-request-connections'
import { onRuntimeEnvironmentDiagnostics } from '../../ipc/runtime-environments/status/runtime-environment-diagnostics-broadcast'

type Settled = Exclude<SharedHostLink, 'connecting'>

// A dial still unsettled after this reads as away (the share link's old redial pace).
const CONNECT_SETTLE_MS = 15_000
const REQUEST_TIMEOUT_MS = 15_000

export type SharedBotHostLink = {
  current: () => SharedHostLink
  /** Opens the host's connection unless it is live; resolves once that dial settles. */
  connect: () => Promise<Settled>
  /** The dial in flight, or how the link stands now. */
  settled: () => Promise<Settled>
  request: (method: string, params: unknown) => Promise<RuntimeRpcResponse<unknown>>
  close: () => void
}

export function sharedBotHostLink(deps: {
  environmentId: string
  /** Whether the share still has a credential to dial: once refused, it is unpaired until re-accepted. */
  hasCredential: () => boolean
  onLinkChanged: (link: SharedHostLink, previous: SharedHostLink) => void
}): SharedBotHostLink {
  const { environmentId } = deps
  let waiters: ((settled: Settled) => void)[] = []
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  // Ready is live, and a closed connection away (unpaired once its credential is gone). A dial reads
  // as connecting only until the host first answers or is found away: a redial behind a drop, or
  // inside Relay's host-offline hold (one open channel the whole outage), stays away until it answers.
  const linkOf = (
    diagnostics: RemoteRuntimeSharedConnectionDiagnostics,
    current: SharedHostLink
  ): SharedHostLink => {
    if (diagnostics.state === 'ready') {
      return 'live'
    }
    if (diagnostics.state === 'closed' || diagnostics.state === 'reconnecting') {
      return deps.hasCredential() ? 'offline' : 'unpaired'
    }
    return current === 'live' || current === 'offline' ? 'offline' : 'connecting'
  }
  const settleAs = (settled: Settled): void => {
    const settling = waiters
    waiters = []
    for (const resolve of settling) {
      resolve(settled)
    }
  }
  // A dial that never answers reads as away; the connection keeps retrying behind it.
  const armSettleTimer = (): void => {
    settleTimer ??= setTimeout(() => {
      settleTimer = null
      if (link === 'connecting') {
        setLink('offline')
      }
    }, CONNECT_SETTLE_MS)
    settleTimer.unref?.()
  }
  const setLink = (next: SharedHostLink): void => {
    if (next !== link) {
      const previous = link
      link = next
      deps.onLinkChanged(next, previous)
    }
    if (next === 'connecting') {
      armSettleTimer()
      return
    }
    if (settleTimer) {
      clearTimeout(settleTimer)
      settleTimer = null
    }
    settleAs(next)
  }
  // The host's connection may already be open (the window's calls open it too).
  const opened = getRemoteRuntimeSharedControlDiagnostics(environmentId)
  let link: SharedHostLink = opened ? linkOf(opened, 'unpaired') : 'unpaired'
  if (link === 'connecting') {
    armSettleTimer()
  }
  const stopListening = onRuntimeEnvironmentDiagnostics((event) => {
    if (event.environmentId === environmentId) {
      setLink(linkOf(event.diagnostics, link))
    }
  })
  const connection = () => {
    const environment = sharedHostEnvironment(environmentId)
    return environment ? getPreferredPairedRuntimeConnection(environment) : null
  }
  const settled = (): Promise<Settled> =>
    link === 'connecting'
      ? new Promise((resolve) => void waiters.push(resolve))
      : Promise.resolve(link)
  return {
    current: () => link,
    connect: () => {
      const paired = connection()
      if (!paired) {
        return Promise.resolve('unpaired')
      }
      // Live, or a dial already under way: reopening it would only cut that dial short.
      if (link === 'live' || link === 'connecting') {
        return settled()
      }
      ensureRemoteRuntimeSharedControlConnection(environmentId, paired)
      reconnectRemoteRuntimeSharedControlConnection(environmentId)
      if (getRemoteRuntimeSharedControlDiagnostics(environmentId)?.state === 'ready') {
        setLink('live')
      } else if (link === 'unpaired') {
        setLink('connecting')
      }
      // Found away before: it redials now, and reads as away until it answers.
      return settled()
    },
    settled,
    request: (method, params) => {
      const paired = connection()
      return paired
        ? sendRemoteRuntimeSharedControlRequest(
            environmentId,
            paired,
            method,
            params,
            REQUEST_TIMEOUT_MS
          )
        : Promise.reject(new Error('shared host not connected'))
    },
    close: () => {
      stopListening()
      endSharedBotHostConnections(environmentId)
      setLink('unpaired')
    }
  }
}

/** An ended share's host: its status owner and every connection to it go, so nothing redials it. */
export function endSharedBotHostConnections(environmentId: string): void {
  closeRemoteRuntimeRequestConnection(environmentId)
}
