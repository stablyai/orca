// This computer's link to one shared agent's host: the host's paired control connection, reached over
// its share's Relay link with the share's device key (shared-host-keys.ts). Its state follows that
// connection's, as a paired server's status does.
import { getPreferredPairedRuntimeConnection } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { sharedHostEnvironment } from '../../../shared/remote-runtime/pairing/shared-host-keys'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../shared/remote-runtime/control/remote-runtime-shared-control-types'
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { SharedHostLink } from '../../../shared/remote-runtime/relay/client/shared-host-relay-link'
import {
  closeRemoteRuntimeSharedControlConnection,
  ensureRemoteRuntimeSharedControlConnection,
  getRemoteRuntimeSharedControlDiagnostics,
  reconnectRemoteRuntimeSharedControlConnection,
  sendRemoteRuntimeSharedControlRequest
} from '../../ipc/runtime-environments/connections/runtime-environment-request-connections'
import { onRuntimeEnvironmentDiagnostics } from '../../ipc/runtime-environments/status/runtime-environment-diagnostics-broadcast'

type Settled = Exclude<SharedHostLink, 'connecting'>

// A dial still unsettled after this reads as away; the connection keeps retrying behind it.
const CONNECT_SETTLE_MS = 30_000
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
  const linkOf = (diagnostics: RemoteRuntimeSharedConnectionDiagnostics): SharedHostLink =>
    diagnostics.state === 'ready'
      ? 'live'
      : diagnostics.state === 'closed' || diagnostics.state === 'reconnecting'
        ? deps.hasCredential()
          ? 'offline'
          : 'unpaired'
        : 'connecting'
  // The host's connection may already be open (the window's calls open it too).
  const opened = getRemoteRuntimeSharedControlDiagnostics(environmentId)
  let link: SharedHostLink = opened ? linkOf(opened) : 'unpaired'
  const settleAs = (settled: Settled): void => {
    const settling = waiters
    waiters = []
    for (const resolve of settling) {
      resolve(settled)
    }
  }
  const setLink = (next: SharedHostLink): void => {
    if (next !== link) {
      const previous = link
      link = next
      deps.onLinkChanged(next, previous)
    }
    if (next !== 'connecting') {
      settleAs(next)
    }
  }
  const stopListening = onRuntimeEnvironmentDiagnostics((event) => {
    if (event.environmentId === environmentId) {
      setLink(linkOf(event.diagnostics))
    }
  })
  const connection = () => {
    const environment = sharedHostEnvironment(environmentId)
    return environment ? getPreferredPairedRuntimeConnection(environment) : null
  }
  const settled = (): Promise<Settled> =>
    link === 'connecting'
      ? new Promise((resolve) => {
          waiters.push(resolve)
          setTimeout(() => resolve(link === 'live' ? 'live' : 'offline'), CONNECT_SETTLE_MS)
        })
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
      setLink(
        getRemoteRuntimeSharedControlDiagnostics(environmentId)?.state === 'ready'
          ? 'live'
          : 'connecting'
      )
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
      closeRemoteRuntimeSharedControlConnection(environmentId)
      setLink('unpaired')
    }
  }
}
