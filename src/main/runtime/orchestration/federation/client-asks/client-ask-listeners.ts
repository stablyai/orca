// Which paired computers are taking asks from this Orca's agents right now. A computer listens from
// its first pull in a session until a pull's caller goes away or it leaves; an answered pull keeps it,
// since it pulls again at once, and a server restart starts with none. A computer seen within the last
// minute is live: `orca bot list` shows only those, and when two computers answer to one address only
// the live ones count, so one that crashed or lost its network between pulls, leaving no pull to end,
// stops showing and never hides or blocks a live one. A lone match still routes however long ago.
import type { z } from 'zod'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { OrchestrationError } from '../../orchestration-error'
import type { BotRosterClient } from '../../../../../shared/bot-roster'
import { toSafeDisplayLine } from '../../../../../shared/text/display-text-safety'
import { systemPowerGeneration } from '../../../../power/system-power-lifecycle'
import type { PeerMailClientAsksPull } from '../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'

export type ClientAskListener = {
  deviceId: string
  installationId: string
  name: string
  /** The pairing fingerprint this Orca keys the computer's conversations by. */
  fingerprint: string
  session: string
  /** Its agents it said a person always lets this Orca's agents ask, as of its latest pull. */
  bots: { id: string; name: string }[]
  /** It allows more than it could name. */
  moreBots?: true
  /** When a pull of its last started or was answered, on `monotonicNow`'s clock. */
  seenAt: number
  /** `systemPowerGeneration()` then: a suspend or resume since means it hasn't been seen awake since. */
  powerGeneration: number
  /** The pull that put this here: only it may end or refresh it, since one session's pulls overlap
   *  across a reconnect. */
  pullId: number
}

export type ClientAskPull = {
  key: string
  session: string
  powerGeneration: number
  pullId: number
}

// Each started pull's identity, so an older pull of the same session ending late never touches the
// state a newer one installed.
let lastPullId = 0

/** How recently a computer must have pulled for `orca bot list` to show it: over twice the longest
 *  pull's wait, so one pulling steadily is never missed between pulls. */
export const CLIENT_ROSTER_LIVE_MS = 60_000

/** The most installations one paired device keeps listening at once; its least recently seen goes
 *  first. A real computer has one, a few copies at most, so a device naming more can't grow this. */
export const CLIENT_INSTALLATIONS_PER_DEVICE = 8

/** Elapsed ms on a clock that never moves back, so setting the system clock can't revive or hide one. */
export function monotonicNow(): number {
  return performance.now()
}

// performance.now() stops while the system sleeps on Linux, so a computer last seen before this
// computer's latest suspend or resume counts as live only once it pulls again; one still connected
// pulls again at once. A headless server gets no power events, so there only the lease applies.
const isLive = (listener: ClientAskListener, now: number, generation: number): boolean =>
  listener.powerGeneration === generation &&
  now - listener.seenAt >= 0 &&
  now - listener.seenAt <= CLIENT_ROSTER_LIVE_MS

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
  pull: z.infer<typeof PeerMailClientAsksPull>,
  now: number = monotonicNow(),
  generation: number = systemPowerGeneration()
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
    session: pull.session,
    bots: pull.bots ?? [],
    ...(pull.moreBots ? { moreBots: true as const } : {}),
    seenAt: now,
    powerGeneration: generation,
    pullId: (lastPullId += 1)
  })
  const ofDevice = [...listeners].filter(
    ([other, listener]) => other !== key && listener.deviceId === caller.deviceId
  )
  if (ofDevice.length >= CLIENT_INSTALLATIONS_PER_DEVICE) {
    ofDevice.sort(([, a], [, b]) => a.seenAt - b.seenAt)
    for (const [other] of ofDevice.slice(
      0,
      ofDevice.length - CLIENT_INSTALLATIONS_PER_DEVICE + 1
    )) {
      listeners.delete(other)
    }
  }
  return { key, session: pull.session, powerGeneration: generation, pullId: lastPullId }
}

/** An answered pull keeps its session; one whose caller went away ends it. Either touches only the
 *  state its own pull installed: a newer pull of the same session (a reconnect) supersedes it. */
export function clientAskPullEnded(
  owner: ClientAskListenerOwner,
  pull: ClientAskPull,
  outcome: 'answered' | 'caller_gone',
  now: number = monotonicNow(),
  generation: number = systemPowerGeneration()
): void {
  const listeners = listenersOf(owner)
  const current = listeners.get(pull.key)
  if (current?.session !== pull.session || current.pullId !== pull.pullId) {
    return
  }
  if (outcome === 'caller_gone') {
    listeners.delete(pull.key)
  } else if (pull.powerGeneration === generation) {
    // A pull begun before a suspend or resume proves nothing about the computer after it.
    current.seenAt = now
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

// The id `--on-client` and a mention token take: a generated UUID, so anything else a computer
// claims is never printed where a server's agent reads it as text or a command.
const PLAIN_ID = /^[\w-]{1,100}$/

/** Every computer seen within the last minute, as this Orca's own `orca bot list` names it: by its
 *  installation id, which `--on-client` takes, with the agents there it said this Orca's agents may ask
 *  without a card. Only a computer that id reaches alone among those seen within the minute is listed,
 *  the same rule `requireListeningClient` settles a tie by, so a listed command never comes back
 *  ambiguous; ids of another shape are left out, and
 *  names, which came from that computer, stay one line. One pass over the listeners. */
export function connectedClientRosters(
  owner: ClientAskListenerOwner,
  now: number = monotonicNow(),
  generation: number = systemPowerGeneration()
): BotRosterClient[] {
  // Only computers seen within the lease count, so one that went silent never hides a live one.
  const listeners = [...listenersOf(owner).values()].filter((listener) =>
    isLive(listener, now, generation)
  )
  // How many listeners a selector matches, by id or by name, counting one matching both once.
  const byId = new Map<string, number>()
  const byName = new Map<string, number>()
  const byBoth = new Map<string, number>()
  const count = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1)
  for (const listener of listeners) {
    const name = listener.name.trim().toLowerCase()
    count(byId, listener.installationId)
    count(byName, name)
    if (name === listener.installationId.toLowerCase()) {
      count(byBoth, listener.installationId)
    }
  }
  const matches = (id: string) =>
    (byId.get(id) ?? 0) + (byName.get(id.toLowerCase()) ?? 0) - (byBoth.get(id) ?? 0)
  return listeners.flatMap((listener) =>
    PLAIN_ID.test(listener.installationId) && matches(listener.installationId) === 1
      ? [
          {
            name: toSafeDisplayLine(listener.name) || listener.installationId,
            onClient: listener.installationId,
            bots: listener.bots
              .filter((bot) => PLAIN_ID.test(bot.id))
              .map((bot) => ({ id: bot.id, name: toSafeDisplayLine(bot.name) || bot.id })),
            ...(listener.moreBots ? { moreBots: true as const } : {})
          }
        ]
      : []
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

/** The one listening computer a selector names; refused when none is connected or two share it.
 *  When two match, only those seen within the lease count, so one that crashed between pulls never
 *  blocks a live one; a lone match routes as it always has, however long since it pulled. */
export function requireListeningClient(
  owner: ClientAskListenerOwner,
  selector: string,
  nothingDone: string,
  now: number = monotonicNow(),
  generation: number = systemPowerGeneration()
): ClientAskListener {
  const matched = listeningClients(owner, selector)
  const live =
    matched.length > 1 ? matched.filter((listener) => isLive(listener, now, generation)) : matched
  const listening = live.length === 1 ? live : matched
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
