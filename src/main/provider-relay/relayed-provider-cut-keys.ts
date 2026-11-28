import {
  RELAY_CUT_KEY_MAX_CHARS,
  RELAY_CUT_KEYS_MAX
} from '../daemon/protocol/daemon-provider-relay-protocol'
import type { ProviderRelayAckFloor } from './relayed-provider-output'

/** The floor's cut keys, or none (the reattach guesses) when they are past what the daemon takes. */
export function boundedCutKeys(
  floor: ProviderRelayAckFloor | undefined,
  through: number | undefined
): string[] | null {
  // An empty list names nothing cut, which a reattach can rely on; only an unnamed one is guessed.
  const keys = floor?.cutKeys?.(through)
  return keys &&
    keys.length <= RELAY_CUT_KEYS_MAX &&
    keys.every((key) => key.length <= RELAY_CUT_KEY_MAX_CHARS)
    ? keys
    : null
}

export type ProviderRelayAckFlags = {
  cut?: true
  held?: true
  cutKeys?: string[]
  savedThrough?: number
}

/** An ack's flags: a cut's names, or, for a floor naming on every ack, what a replay would split
 *  (a release through `target`, without `keepFrom`, splits what is open there too), with where
 *  the journal saved through: a named item's lines to there aren't replayed onto its row again. */
export function relayAckFlags(
  floor: ProviderRelayAckFloor | undefined,
  cut: boolean,
  held: boolean,
  keepFrom: number | null,
  target: number,
  savedThrough: number
): ProviderRelayAckFlags {
  const everyAck = floor?.namesEveryAck === true
  const cutKeys =
    cut || everyAck ? boundedCutKeys(floor, keepFrom === null ? target : undefined) : null
  return {
    ...(cut ? { cut: true as const } : {}),
    ...(held ? { held: true as const } : {}),
    ...(cutKeys ? { cutKeys } : {}),
    ...(cutKeys || everyAck ? { savedThrough } : {})
  }
}
