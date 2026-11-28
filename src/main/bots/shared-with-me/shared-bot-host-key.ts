// A kept share as the paired path reaches its host (shared-host-keys.ts): its device key signs in,
// and its entry keeps the Relay invite and resume credential.
import nacl from 'tweetnacl'
import type {
  SharedHost,
  SharedHostRegistry
} from '../../../shared/remote-runtime/pairing/shared-host-keys'
import type { SharedBotHostEntry, SharedBotHostStore } from './shared-bot-host-store'
import { nextPairingStep } from './shared-bot-pairing'

/** Null before the host's offer: until then there is nothing to dial or sign in to. */
export function sharedHostOfEntry(
  store: SharedBotHostStore,
  entry: SharedBotHostEntry
): SharedHost | null {
  const { offer, shareId } = entry
  if (!offer) {
    return null
  }
  const secretKey = Buffer.from(entry.deviceKey.secretKeyB64, 'base64')
  return {
    name: entry.botName,
    offer,
    credential: {
      kind: 'device-key',
      deviceId: offer.deviceId,
      sign: async (message) => nacl.sign.detached(message, secretKey)
    },
    relay: {
      entry: () => store.get(shareId),
      // Only the link's own fields change here; the rest of the entry is read fresh.
      save: (next) => {
        const current = store.get(shareId)
        if (current) {
          store.put({
            ...current,
            refusedInvite: next.refusedInvite,
            pendingResume: next.pendingResume,
            resume: next.resume
          })
        }
      }
    }
  }
}

/** As the Relay opener reads it: a resume credential, one whose install may have committed, or an
 *  unspent invite. Whether the host is online never decides it. */
export function hasRelayCredential(entry: SharedBotHostEntry | undefined, now: number): boolean {
  return (
    !!entry &&
    (entry.pendingResume !== undefined ||
      nextPairingStep(entry, { hostOnline: false }, now).kind === 'connect')
  )
}

/** The kept shares as the paired path reads them: those `listed` still, once `ready` loaded them. */
export function keptSharedHostRegistry(
  store: SharedBotHostStore,
  listed: () => readonly SharedBotHostEntry[],
  ready: () => Promise<void>
): SharedHostRegistry {
  return {
    host: (environmentId) => {
      const entry = store.list().find((kept) => kept.environmentId === environmentId)
      return entry ? sharedHostOfEntry(store, entry) : null
    },
    // Those whose host has made its offer, as `host` answers them.
    environmentIds: () => listed().flatMap((entry) => (entry.offer ? [entry.environmentId] : [])),
    ready
  }
}
