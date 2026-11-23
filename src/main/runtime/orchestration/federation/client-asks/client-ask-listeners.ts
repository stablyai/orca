// Which paired computers are taking asks from this Orca's agents right now. A computer listens from
// its first pull in a session until a pull's caller goes away or it leaves; an answered pull keeps it,
// since it pulls again at once. Nothing is timed, and a server restart starts with none.
import type { z } from 'zod'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { OrchestrationError } from '../../orchestration-error'
import type { PeerMailClientAsksPull } from '../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'

export type ClientAskListener = {
  deviceId: string
  installationId: string
  name: string
  /** The pairing fingerprint this Orca keys the computer's conversations by. */
  fingerprint: string
  session: string
}

export type ClientAskPull = { key: string; session: string }

/** The runtime whose server the computers listen on; a test's runtimes keep separate listeners. */
export type ClientAskListenerOwner = Pick<OrcaRuntimeService, 'getOrchestrationDb'>

const listenersByOwner = new WeakMap<ClientAskListenerOwner, Map<string, ClientAskListener>>()
// The name each computer last pulled with, so a send while it's away can still name it.
const namesByOwner = new WeakMap<ClientAskListenerOwner, Map<string, string>>()
// Each pairing a re-pair replaced, by installation, to the pairing that replaced it; kept past the
// pull that announced it, so a reply on the older conversation follows the computer.
const replacementsByOwner = new WeakMap<ClientAskListenerOwner, Map<string, string>>()

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
  // The pairing it replaced pulls no more, so that pairing's last session stops counting.
  for (const [other, listener] of listeners) {
    if (
      pull.previousPairing !== undefined &&
      listener.fingerprint === pull.previousPairing &&
      listener.installationId === pull.installationId
    ) {
      listeners.delete(other)
    }
  }
  let names = namesByOwner.get(owner)
  if (!names) {
    names = new Map()
    namesByOwner.set(owner, names)
  }
  names.set(pull.installationId, pull.name)
  if (pull.previousPairing !== undefined && pull.previousPairing !== caller.fingerprint) {
    let replacements = replacementsByOwner.get(owner)
    if (!replacements) {
      replacements = new Map()
      replacementsByOwner.set(owner, replacements)
    }
    replacements.set(keyOf(pull.previousPairing, pull.installationId), caller.fingerprint)
  }
  listeners.set(key, {
    deviceId: caller.deviceId,
    installationId: pull.installationId,
    name: pull.name,
    fingerprint: caller.fingerprint,
    session: pull.session
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
  if (outcome === 'caller_gone' && current?.session === pull.session) {
    listeners.delete(pull.key)
  }
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

/** The name a computer last pulled with since this Orca started; null for one it hasn't seen. */
export function lastClientAskName(
  owner: ClientAskListenerOwner,
  installationId: string
): string | null {
  return namesByOwner.get(owner)?.get(installationId.trim()) ?? null
}

export function forgetClientAskDevice(owner: ClientAskListenerOwner, deviceId: string): void {
  const listeners = listenersOf(owner)
  for (const [key, listener] of listeners) {
    if (listener.deviceId === deviceId) {
      listeners.delete(key)
    }
  }
}

/** The one listening computer a selector names; refused when none is connected or two share it. */
export function requireListeningClient(
  owner: ClientAskListenerOwner,
  selector: string,
  nothingDone: string
): ClientAskListener {
  const listening = listeningClients(owner, selector)
  if (listening.length > 1) {
    throw new OrchestrationError(
      'invalid_argument',
      `Two paired computers answer to ${selector}. ${nothingDone}`,
      { effectsApplied: false }
    )
  }
  const [client] = listening
  if (!client) {
    throw new OrchestrationError(
      'remote_runtime_unavailable',
      `${selector} is offline: it isn't connected to this Orca right now. ${nothingDone}`,
      { effectsApplied: false }
    )
  }
  return client
}

/** The listening computer a conversation's environment names: the same device first, so copies
 *  sharing an installation id stay apart; else the one that re-paired from `pairing`. */
export function listenerForClientEnvironment(
  owner: ClientAskListenerOwner,
  deviceId: string,
  installationId: string,
  pairing: string
): ClientAskListener | null {
  const listeners = listenersOf(owner)
  const same = listeners.get(keyOf(deviceId, installationId))
  if (same) {
    return same
  }
  // The newest pairing that replaced this one, through every re-pair since.
  const replacements = replacementsByOwner.get(owner)
  const seen = new Set<string>()
  let current = pairing
  while (!seen.has(current) && replacements?.has(keyOf(current, installationId))) {
    seen.add(current)
    current = replacements.get(keyOf(current, installationId))!
  }
  const repaired = [...listeners.values()].filter(
    (listener) =>
      listener.installationId === installationId &&
      current !== pairing &&
      listener.fingerprint === current
  )
  return repaired.length === 1 ? repaired[0]! : null
}
