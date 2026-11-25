// This computer's relay link to one shared agent's host, signing with the device key its entry keeps.
import { randomBytes, randomUUID } from 'node:crypto'
import nacl from 'tweetnacl'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/remote-runtime/protocol/electron-remote-runtime-client-capabilities'
import { remoteRuntimeClientCapabilities } from '../../../shared/remote-runtime/remote-runtime-client-capabilities'
import {
  SharedHostRelayLink,
  type SharedHostRelayLinkDeps
} from '../../../shared/remote-runtime/relay/client/shared-host-relay-link'
import type { SharedBotHostEntry } from './shared-bot-host-store'

export type SharedBotHostLink = SharedHostRelayLink<SharedBotHostEntry>

export function sharedBotHostLink(
  deps: Omit<
    SharedHostRelayLinkDeps<SharedBotHostEntry>,
    'sign' | 'randomBytes' | 'newId' | 'clientCapabilities'
  >
): SharedBotHostLink {
  return new SharedHostRelayLink({
    ...deps,
    // This desktop reads a shared host's chats as it reads a paired server's.
    clientCapabilities: remoteRuntimeClientCapabilities(
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    ),
    sign: async (entry, message) =>
      nacl.sign.detached(message, Buffer.from(entry.deviceKey.secretKeyB64, 'base64')),
    randomBytes: (length) => new Uint8Array(randomBytes(length)),
    newId: randomUUID
  })
}
