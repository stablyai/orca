// Which paired computers are taking asks from this Orca's agents right now. A computer listens from
// its first pull in a session until a pull's caller goes away or it leaves; an answered pull keeps it,
// since it pulls again at once. Nothing is timed, and a server restart starts with none.
import type { z } from 'zod'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { PeerMailClientAsksPull } from '../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'

export type ClientAskListener = {
  deviceId: string
  installationId: string
  name: string
  /** The pairing fingerprint this Orca keys the computer's conversations by. */
  fingerprint: string
  session: string
  inFlight: number
}

export type ClientAskPull = { key: string; session: string }

/** The runtime whose server the computers listen on; a test's runtimes keep separate listeners. */
export type ClientAskListenerOwner = Pick<OrcaRuntimeService, 'getOrchestrationDb'>

const listenersByOwner = new WeakMap<ClientAskListenerOwner, Map<string, ClientAskListener>>()

function listenersOf(owner: ClientAskListenerOwner): Map<string, ClientAskListener> {
  let listeners = listenersByOwner.get(owner)
  if (!listeners) {
    listeners = new Map()
    listenersByOwner.set(owner, listeners)
  }
  return listeners
}

const keyOf = (deviceId: string, installationId: string): string => `${deviceId}\0${installationId}`

/** A pull naming a session begins; a leave ends the session and returns null. */
export function clientAskPullStarted(
  owner: ClientAskListenerOwner,
  caller: { deviceId: string; fingerprint: string },
  pull: z.infer<typeof PeerMailClientAsksPull>
): ClientAskPull | null {
  const listeners = listenersOf(owner)
  const key = keyOf(caller.deviceId, pull.installationId)
  const current = listeners.get(key)
  if (pull.leave) {
    if (current?.session === pull.session) {
      listeners.delete(key)
    }
    return null
  }
  const same = current?.session === pull.session
  listeners.set(key, {
    deviceId: caller.deviceId,
    installationId: pull.installationId,
    name: pull.name,
    fingerprint: caller.fingerprint,
    session: pull.session,
    inFlight: (same ? current.inFlight : 0) + 1
  })
  return { key, session: pull.session }
}

/** An answered pull keeps its session; one whose caller went away ends it. Either touches only its own session. */
export function clientAskPullEnded(
  owner: ClientAskListenerOwner,
  pull: ClientAskPull,
  outcome: 'answered' | 'caller_gone'
): void {
  const listeners = listenersOf(owner)
  const current = listeners.get(pull.key)
  if (current?.session !== pull.session) {
    return
  }
  if (outcome === 'caller_gone') {
    listeners.delete(pull.key)
    return
  }
  current.inFlight = Math.max(0, current.inFlight - 1)
}

/** The listening computers a selector names: its installation id, or its name. */
export function listeningClients(
  owner: ClientAskListenerOwner,
  selector: string
): ClientAskListener[] {
  const wanted = selector.trim().toLowerCase()
  return [...listenersOf(owner).values()].filter(
    (listener) =>
      listener.installationId === selector.trim() || listener.name.trim().toLowerCase() === wanted
  )
}

export function forgetClientAskDevice(owner: ClientAskListenerOwner, deviceId: string): void {
  const listeners = listenersOf(owner)
  for (const [key, listener] of listeners) {
    if (listener.deviceId === deviceId) {
      listeners.delete(key)
    }
  }
}
