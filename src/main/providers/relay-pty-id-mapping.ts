import { toAppSshPtyId, toRelaySshPtyId } from './ssh-pty-id'

export type RelayPtyIdMapping = {
  toAppPtyId: (relayPtyId: string) => string
  toRelayPtyId: (appPtyId: string) => string
}

export function sshRelayPtyIdMapping(connectionId: string): RelayPtyIdMapping {
  return {
    toAppPtyId: (id) => toAppSshPtyId(connectionId, id),
    toRelayPtyId: (id) => toRelaySshPtyId(connectionId, id)
  }
}
