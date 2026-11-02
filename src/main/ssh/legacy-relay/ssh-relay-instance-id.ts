import { createHash } from 'node:crypto'

export function hashRelayInstanceId(relayInstanceId: string): string {
  return createHash('sha256').update(relayInstanceId).digest('hex').slice(0, 16)
}

export function relaySocketNameForInstanceId(relayInstanceId: string | undefined): string {
  return relayInstanceId ? `relay-${hashRelayInstanceId(relayInstanceId)}.sock` : 'relay.sock'
}
