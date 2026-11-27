import {
  RELAY_CUT_KEY_MAX_CHARS,
  RELAY_CUT_KEYS_MAX,
  RELAY_CUT_KEYS_OVERFLOW
} from '../../daemon/protocol/daemon-provider-relay-protocol'

/** `last`: its latest chunk's seq, so the ones streamed last are kept and named. */
export type AcpRelayItem = { session?: string; child: boolean; last?: number }
/** The tag a continuation puts before a moved message's id (`relay:<relay>:<seq>:`). */
export const CONTINUED_ID = /^relay:[^:]*:\d+:/

/**
 * The cut keys for messages a replay would split, keyed as the continuation keys them (a moved
 * id names its original). Only a session's latest few can resume, so those streamed last are named,
 * at most `perSessionCap` per session and within the daemon's cap; past that the overflow key says
 * more were split, and a reattach moves every item it meets.
 */
export function acpCutKeyNames(
  named: [string, AcpRelayItem & { seq?: number }][],
  perSessionCap: number,
  carriedOverflow: boolean
): string[] {
  const last = ([, item]: [string, AcpRelayItem & { seq?: number }]) => item.last ?? item.seq ?? 0
  named.sort((a, b) => last(b) - last(a))
  const keys = new Set<string>()
  const perSession = new Map<string | undefined, number>()
  let overflow = false
  for (const [id, item] of named) {
    const key = JSON.stringify([item.session, id.replace(CONTINUED_ID, '')])
    if (keys.has(key)) {
      continue
    }
    const count = perSession.get(item.session) ?? 0
    if (
      count >= perSessionCap ||
      keys.size >= RELAY_CUT_KEYS_MAX - 1 ||
      key.length > RELAY_CUT_KEY_MAX_CHARS
    ) {
      overflow = true
      continue
    }
    perSession.set(item.session, count + 1)
    keys.add(key)
  }
  return overflow || carriedOverflow ? [...keys, RELAY_CUT_KEYS_OVERFLOW] : [...keys]
}
