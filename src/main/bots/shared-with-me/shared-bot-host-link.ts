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
import { clearRelayDialHolds } from '../../ipc/runtime-environments/connections/runtime-environment-relay-link'

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
  let closed = false
  // Ready is live, and a closed connection away (unpaired once its credential is gone). The link
  // reads as connecting only until the host first answers or is found away: a redial behind a drop,
  // or inside Relay's host-offline hold (one open channel the whole outage), stays away until it
  // answers. Whether a dial is in flight is tracked apart (`dial`), so connect() still awaits it.
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
  const opened = getRemoteRuntimeSharedControlDiagnostics(environmentId)
  // The host's connection may already be open (the window's calls open it too).
  let link: SharedHostLink = opened ? linkOf(opened, 'unpaired') : 'unpaired'
  const setLink = (next: SharedHostLink): void => {
    if (closed || next === link) {
      return
    }
    const previous = link
    link = next
    deps.onLinkChanged(next, previous)
  }
  // The dial this link awaits: settled by the host answering (live), by the connection closing after
  // it tried (away or unpaired), or by its bound (away; the connection keeps retrying behind it).
  let dial: {
    settled: Promise<Settled>
    sawAttempt: boolean
    settle: (settled: Settled) => void
  } | null = null
  const settleDial = (settled: Settled): void => {
    const current = dial
    dial = null
    current?.settle(settled)
  }
  const awaitDial = (): Promise<Settled> => {
    if (dial) {
      return dial.settled
    }
    let settle: (settled: Settled) => void = () => {}
    const settled = new Promise<Settled>((resolve) => (settle = resolve))
    const timer = setTimeout(() => {
      if (dial?.settled === settled) {
        settleDial('offline')
        if (link === 'connecting') {
          setLink('offline')
        }
      }
    }, CONNECT_SETTLE_MS)
    timer.unref?.()
    dial = {
      settled,
      sawAttempt: false,
      settle: (outcome) => {
        clearTimeout(timer)
        settle(outcome)
      }
    }
    return settled
  }
  const stopListening = onRuntimeEnvironmentDiagnostics((event) => {
    if (event.environmentId !== environmentId) {
      return
    }
    const { state } = event.diagnostics
    setLink(linkOf(event.diagnostics, link))
    if (!dial) {
      return
    }
    if (state === 'ready') {
      settleDial('live')
    } else if (state === 'awaiting_ready' || state === 'awaiting_authenticated') {
      dial.sawAttempt = true
    } else if (dial.sawAttempt || !deps.hasCredential()) {
      // Closed after this dial tried (the close that reopened it is not its outcome), or refused at
      // once with no credential left to dial.
      settleDial(deps.hasCredential() ? 'offline' : 'unpaired')
    }
  })
  const connection = () => {
    const environment = sharedHostEnvironment(environmentId)
    return environment ? getPreferredPairedRuntimeConnection(environment) : null
  }
  const dialInFlight = (): boolean => {
    const state = getRemoteRuntimeSharedControlDiagnostics(environmentId)?.state
    return state === 'awaiting_ready' || state === 'awaiting_authenticated'
  }
  /** Joins a dial already under way: the connection's own, or one asked for here. */
  const joinDial = (): Promise<Settled> | null => {
    if (dial) {
      return dial.settled
    }
    if (!dialInFlight()) {
      return null
    }
    const settled = awaitDial()
    dial!.sawAttempt = true
    return settled
  }
  const settled = (): Promise<Settled> =>
    link === 'live'
      ? Promise.resolve('live')
      : (joinDial() ?? Promise.resolve(link === 'connecting' ? 'offline' : link))
  return {
    current: () => link,
    connect: () => {
      const paired = connection()
      if (!paired || closed) {
        return Promise.resolve('unpaired')
      }
      if (link === 'live') {
        return Promise.resolve('live')
      }
      // A dial already under way is awaited, never reopened: that would cut its handshake short.
      const joined = joinDial()
      if (joined) {
        return joined
      }
      const settledDial = awaitDial()
      // Asked for now (the host is back, or a phone needs it): no stale host-offline hold delays it.
      clearRelayDialHolds(environmentId)
      ensureRemoteRuntimeSharedControlConnection(environmentId, paired)
      reconnectRemoteRuntimeSharedControlConnection(environmentId)
      if (getRemoteRuntimeSharedControlDiagnostics(environmentId)?.state === 'ready') {
        setLink('live')
        settleDial('live')
      } else if (link === 'unpaired') {
        // Found away before, it reads as away until it answers.
        setLink('connecting')
      }
      return settledDial
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
      setLink('unpaired')
      closed = true
      settleDial('unpaired')
      endSharedBotHostConnections(environmentId)
    }
  }
}

/** An ended share's host: its status owner and every connection to it go, so nothing redials it. */
export function endSharedBotHostConnections(environmentId: string): void {
  closeRemoteRuntimeRequestConnection(environmentId)
}
