// The relay grants and shared-tool callers of the agents a daemon start keeps, in memory only: each
// arrives with its agent's spawn and goes when that agent's relay ends or its owner is revoked. The
// app reads them back only on its authenticated serve request, so a restarted app recognizes the
// tokens its kept agents still carry. Nothing reaches disk.
import { jsonObject } from '../../../shared/json-stream/json-value-property'
import type {
  ToolRelayFrontCaller,
  ToolRelayFrontGrant,
  ToolRelayFrontKept,
  ToolRelayFrontKeptRelay
} from '../protocol/daemon-tool-relay-front-protocol'

/** Bounds on what one spawn may hand over; a launch has one owner, two at most in practice. */
const MAX_GRANTS = 8
const MAX_CALLER_VALUES = 64
const MAX_TEXT = 8 * 1024

const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT

function readGrant(value: unknown): ToolRelayFrontGrant | null {
  const grant = jsonObject(value)
  const folders = jsonObject(grant?.folders)
  if (!grant || !folders || !text(grant.owner) || !text(grant.token)) {
    return null
  }
  const { bot, host } = folders
  if ((bot !== undefined && !text(bot)) || (host !== undefined && !text(host))) {
    return null
  }
  return {
    owner: grant.owner,
    token: grant.token,
    folders: { ...(bot === undefined ? {} : { bot }), ...(host === undefined ? {} : { host }) }
  }
}

function readCaller(value: unknown): ToolRelayFrontCaller | null {
  const caller = jsonObject(value)
  const env = jsonObject(caller?.caller)
  if (!caller || !env || !text(caller.owner) || !text(caller.token)) {
    return null
  }
  const entries = Object.entries(env)
  if (entries.length > MAX_CALLER_VALUES) {
    return null
  }
  const values: Record<string, string> = {}
  for (const [name, entry] of entries) {
    if (!text(entry)) {
      return null
    }
    values[name] = entry
  }
  return { owner: caller.owner, token: caller.token, caller: values }
}

/** Null when the spawn sent nothing (or anything malformed, which keeps nothing). */
export function readToolRelayFrontKept(value: unknown): ToolRelayFrontKept | null {
  const kept = jsonObject(value)
  if (!kept || !Array.isArray(kept.grants) || kept.grants.length > MAX_GRANTS) {
    return null
  }
  const grants = kept.grants.map(readGrant)
  const caller = kept.caller === undefined ? undefined : readCaller(kept.caller)
  if (grants.some((grant) => grant === null) || caller === null) {
    return null
  }
  return { grants: grants.filter((grant) => grant !== null), ...(caller ? { caller } : {}) }
}

export class DaemonToolRelayKeptGrants {
  private readonly relays = new Map<string, ToolRelayFrontKeptRelay>()

  /** Before the agent spawns; false when nothing usable was sent. */
  keep(relayId: string, chatKey: string, sent: unknown): boolean {
    const kept = readToolRelayFrontKept(sent)
    if (!kept || (kept.grants.length === 0 && !kept.caller)) {
      return false
    }
    this.relays.set(relayId, { relayId, chatKey, ...kept })
    return true
  }

  /** The relay ended (or never started): its agent's tokens are no one's from now on. */
  forget(relayId: string): void {
    this.relays.delete(relayId)
  }

  /** The owner's grants and callers leave every relay. */
  revoke(owner: string): void {
    for (const [relayId, kept] of this.relays) {
      const grants = kept.grants.filter((grant) => grant.owner !== owner)
      const caller = kept.caller?.owner === owner ? undefined : kept.caller
      if (grants.length === 0 && !caller) {
        this.relays.delete(relayId)
      } else {
        this.relays.set(relayId, {
          relayId,
          chatKey: kept.chatKey,
          grants,
          ...(caller ? { caller } : {})
        })
      }
    }
  }

  holds(relayId: string): boolean {
    return this.relays.has(relayId)
  }

  list(): ToolRelayFrontKeptRelay[] {
    return [...this.relays.values()]
  }

  clear(): void {
    this.relays.clear()
  }
}
