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
