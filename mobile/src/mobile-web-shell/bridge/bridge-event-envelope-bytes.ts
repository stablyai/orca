import { BRIDGE_ID_PATTERN, BRIDGE_PROTOCOL_VERSION } from './bridge-envelope'

// Derive the widest id from its fixed-length pattern so protocol width changes update the frame budget.
export function bridgeIdChars(): number {
  const quantifier = /\{(\d+)\}\$$/.exec(BRIDGE_ID_PATTERN.source)
  // Fail if ids stop having fixed width; guessing would silently underbudget frames.
  if (quantifier === null) {
    throw new Error('the bridge id pattern is no longer a fixed length')
  }
  return Number(quantifier[1])
}

// Share one envelope budget for page-requested snapshots and shell-merged output. Use full-width id and maximum seq; payload:0 leaves exactly the surrounding JSON cost.
export function bridgeEventEnvelopeBytes(id = 'a'.repeat(bridgeIdChars())): number {
  return JSON.stringify({
    v: BRIDGE_PROTOCOL_VERSION,
    type: 'event',
    id,
    seq: Number.MAX_SAFE_INTEGER,
    payload: 0
  }).length
}
