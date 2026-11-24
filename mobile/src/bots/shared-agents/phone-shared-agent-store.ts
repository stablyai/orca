// The agents shared with the account of a computer this phone is paired to, each with the key that
// computer got this phone from the agent's host. What a stolen copy would let someone use (the device
// key, the share credential, the relay credentials) is kept in the keychain; the rest, as for kept
// bots, in app storage.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { z } from 'zod'
import { BotTeamShareOffer } from '../../../../src/shared/bots/bot-team-share-seal'
import {
  deletePairingKeychainItem,
  readPairingKeychainItem,
  writePairingKeychainItem
} from '../../host-credentials/pairing-keychain'

const INDEX_KEY = 'orca:shared-agents:v1'
// SecureStore keys take [A-Za-z0-9._-] only.
const secretsKey = (shareId: string) => `orca.shared-agent.${shareId}`

const Text = z.string().min(1)

const PhoneSharedAgentHeld = z.object({
  clientMessageId: Text,
  chat: z.union([z.object({ sessionId: Text }), z.object({ newChatId: Text })]),
  startedAs: Text.optional(),
  // Kept here to draw it in its chat and send it again if the host refuses it.
  text: z.string(),
  sentAt: z.number().int().nonnegative()
})
export type PhoneSharedAgentHeld = z.infer<typeof PhoneSharedAgentHeld>

const PhoneSharedAgentListing = z.object({
  // The computer that got this phone its key: the agent is listed under it.
  pairedHostId: Text,
  shareId: Text,
  botId: Text,
  botName: Text,
  ownerName: Text,
  // That computer's id for the agent's host, which its pages route calls by.
  environmentId: Text,
  connectorOrigin: Text,
  // The host key the computer pinned; the offer must name the same one.
  hostKey: Text,
  held: z.array(PhoneSharedAgentHeld)
})

const PhoneSharedAgentSecrets = z.object({
  deviceKey: z.object({ publicKeyB64: Text, secretKeyB64: Text }),
  // Sent as `Bearer` to hold messages and read their states; Orca Cloud keeps only its hash.
  credential: Text,
  offer: BotTeamShareOffer,
  refusedInvite: Text.optional(),
  pendingResume: z.object({ token: Text, hash: Text, reqId: Text }).optional(),
  resume: z
    .object({
      token: Text,
      hash: Text,
      version: z.number().int().positive(),
      relay: z.object({ cellUrl: Text, relayHostId: Text })
    })
    .optional()
})

export type PhoneSharedAgent = z.infer<typeof PhoneSharedAgentListing> &
  z.infer<typeof PhoneSharedAgentSecrets>

/** Read once; every change is kept in memory at once and written behind, in order. */
export class PhoneSharedAgentStore {
  private entries: PhoneSharedAgent[] = []
  private loaded: Promise<void> | null = null
  private writes: Promise<void> = Promise.resolve()

  load(): Promise<void> {
    this.loaded ??= this.read().then((entries) => {
      this.entries = entries
    })
    return this.loaded
  }

  list(): readonly PhoneSharedAgent[] {
    return this.entries
  }

  get(shareId: string): PhoneSharedAgent | undefined {
    return this.entries.find((entry) => entry.shareId === shareId)
  }

  put(entry: PhoneSharedAgent): void {
    this.entries = [...this.entries.filter((other) => other.shareId !== entry.shareId), entry]
    this.write(() => writePairingKeychainItem(secretsKey(entry.shareId), secretsOf(entry)))
  }

  remove(shareIds: ReadonlySet<string>): void {
    if (!this.entries.some((entry) => shareIds.has(entry.shareId))) {
      return
    }
    this.entries = this.entries.filter((entry) => !shareIds.has(entry.shareId))
    this.write(async () => {
      for (const shareId of shareIds) {
        await deletePairingKeychainItem(secretsKey(shareId))
      }
    })
  }

  /** Every write so far is on the device. */
  flushed(): Promise<void> {
    return this.writes
  }

  // The index after the secrets, so a listed entry always has its secrets to read.
  private write(secrets: () => Promise<void>): void {
    // The listing schema drops every key it doesn't name, the secrets among them.
    const index = JSON.stringify(this.entries.map((entry) => PhoneSharedAgentListing.parse(entry)))
    this.writes = this.writes
      .then(secrets)
      .then(() => AsyncStorage.setItem(INDEX_KEY, index))
      .catch((error: unknown) =>
        console.warn('[shared-agents] could not keep shared agents', error)
      )
  }

  // Entry by entry: one this build can't read, or whose secrets are gone, is dropped, never the rest.
  private async read(): Promise<PhoneSharedAgent[]> {
    const raw = await AsyncStorage.getItem(INDEX_KEY).catch(() => null)
    const listed = z.array(z.unknown()).safeParse(parseJson(raw))
    const entries: PhoneSharedAgent[] = []
    for (const row of listed.data ?? []) {
      const listing = PhoneSharedAgentListing.safeParse(row).data
      const stored = listing
        ? await readPairingKeychainItem(secretsKey(listing.shareId)).catch(() => null)
        : null
      const secrets = PhoneSharedAgentSecrets.safeParse(parseJson(stored)).data
      if (listing && secrets) {
        entries.push({ ...listing, ...secrets })
      }
    }
    return entries
  }
}

function parseJson(raw: string | null): unknown {
  try {
    return raw === null ? null : JSON.parse(raw)
  } catch {
    return null
  }
}

function secretsOf(entry: PhoneSharedAgent): string {
  const secrets: z.infer<typeof PhoneSharedAgentSecrets> = {
    deviceKey: entry.deviceKey,
    credential: entry.credential,
    offer: entry.offer,
    ...(entry.refusedInvite ? { refusedInvite: entry.refusedInvite } : {}),
    ...(entry.pendingResume ? { pendingResume: entry.pendingResume } : {}),
    ...(entry.resume ? { resume: entry.resume } : {})
  }
  return JSON.stringify(secrets)
}
