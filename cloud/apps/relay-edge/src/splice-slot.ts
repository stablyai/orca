// Splices run in a reused pool of SpliceRelay objects per host, so a phone connect never pays for
// creating a new object. connId = `<relayHostId>.<slot>.<uuid>`; the object is `<relayHostId>.<slot>`.
import { RELAY_PROTOCOL_LIMITS } from '../../../packages/relay-contract/src/protocol-limits'
import { HOST_ID } from './jwt'

export const SPLICE_SLOTS = RELAY_PROTOCOL_LIMITS.maxConnectionsPerHost

export function makeConnId(relayHostId: string, slot: number): string {
  return `${relayHostId}.${slot}.${crypto.randomUUID()}`
}

export function parseConnId(connId: string): { relayHostId: string; slot: number; object: string } | null {
  if (connId.length > 128) { return null }
  const [relayHostId, slotText, rest] = connId.split('.', 3)
  if (!HOST_ID.test(relayHostId) || !/^\d+$/.test(slotText ?? '') || !rest) { return null }
  const slot = Number(slotText)
  if (slot >= SPLICE_SLOTS) { return null }
  return { relayHostId, slot, object: `${relayHostId}.${slot}` }
}
