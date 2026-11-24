// The agents other people shared with this Orca account, one entry per share: this device's keys for it,
// the host's offer and the relay resume credential. Kept apart from the paired-server registry, which
// older builds read and would dial as a paired server.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { BotTeamShareOffer } from '../../../shared/bots/bot-team-share-seal'
import { BotShareIdSchema } from '../../../shared/bots/bot-team-shares'
import { writeSecureFileAsync } from '../../../shared/secure-storage/secure-file-async-write'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../shared/remote-runtime/e2ee/node/paired-e2ee-node-primitives'
import nacl from 'tweetnacl'

export const SHARED_BOT_HOSTS_FILENAME = 'shared-bot-hosts.json'

const Text = z.string().min(1)
const KeyPair = z.object({ publicKeyB64: Text, secretKeyB64: Text })

export const SharedBotHeldMessage = z.object({
  clientMessageId: Text,
  chat: z.union([z.object({ sessionId: Text }), z.object({ newChatId: Text })]),
  sentAt: z.number().int().nonnegative()
})
export type SharedBotHeldMessage = z.infer<typeof SharedBotHeldMessage>

const ResumeCredential = z.object({
  token: Text,
  hash: Text,
  version: z.number().int().positive(),
  // Where the host's relay is now: it can move cells after the invite.
  relay: z.object({ cellUrl: Text, relayHostId: Text })
})

const SharedBotHostEntry = z.object({
  shareId: BotShareIdSchema,
  // The paired-server id the app routes this host's calls by; minted once, kept for the share's life.
  environmentId: Text,
  botId: Text,
  botName: Text,
  ownerName: Text,
  avatarUrl: z.string().optional(),
  // The host's E2EE key held messages are sealed to; absent, nothing is held for it.
  hostKey: Text.optional(),
  // Ed25519: signs the relay auth and held messages. Curve25519: the host seals its offer to it.
  deviceKey: KeyPair,
  sealKey: KeyPair,
  // The host's latest answer: its key and this device's id there, and a relay invite while unexpired.
  offer: BotTeamShareOffer.optional(),
  // The offer's invite the relay refused (spent or expired early): never dialed again.
  refusedInvite: Text.optional(),
  // Minted and persisted before install, so a lost reply retries the same request.
  pendingResume: z.object({ token: Text, hash: Text, reqId: Text }).optional(),
  resume: ResumeCredential.optional(),
  acceptedAt: z.number().int().nonnegative().optional(),
  // This computer's folder workspace its chats open in; absent until made (and in a store from before).
  homeWorkspaceId: Text.optional(),
  held: z.array(SharedBotHeldMessage)
})
export type SharedBotHostEntry = z.infer<typeof SharedBotHostEntry>

/** A share seen for the first time: a fresh environment id, and fresh keys this device keeps for it. */
export function newSharedBotHostEntry(share: {
  shareId: string
  botId: string
  botName: string
  ownerName: string
}): SharedBotHostEntry {
  const device = nacl.sign.keyPair()
  const seal = NODE_PAIRED_E2EE_PRIMITIVES.generateKeyPair()
  const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')
  return {
    shareId: share.shareId,
    environmentId: randomUUID(),
    botId: share.botId,
    botName: share.botName,
    ownerName: share.ownerName,
    deviceKey: { publicKeyB64: b64(device.publicKey), secretKeyB64: b64(device.secretKey) },
    sealKey: { publicKeyB64: b64(seal.publicKey), secretKeyB64: b64(seal.secretKey) },
    held: []
  }
}

const SharedBotHostsFile = z.object({ v: z.literal(1), shares: z.array(z.unknown()) })

/** Entry by entry, so one this build can't read is dropped, never the whole file. */
function parseFile(text: string): SharedBotHostEntry[] {
  const file = SharedBotHostsFile.safeParse(JSON.parse(text))
  return file.success
    ? file.data.shares.flatMap((entry) => SharedBotHostEntry.safeParse(entry).data ?? [])
    : []
}

/** Read once at start; every change is kept in memory at once and written behind, in order. */
export class SharedBotHostStore {
  private readonly path: string
  private entries: SharedBotHostEntry[] = []
  private writes: Promise<void> = Promise.resolve()

  constructor(userDataPath: string) {
    this.path = join(userDataPath, SHARED_BOT_HOSTS_FILENAME)
  }

  async load(): Promise<void> {
    try {
      this.entries = parseFile(await readFile(this.path, 'utf8'))
    } catch {
      this.entries = []
    }
  }

  list(): readonly SharedBotHostEntry[] {
    return this.entries
  }

  get(shareId: string): SharedBotHostEntry | undefined {
    return this.entries.find((entry) => entry.shareId === shareId)
  }

  put(entry: SharedBotHostEntry): void {
    this.write([...this.entries.filter((other) => other.shareId !== entry.shareId), entry])
  }

  remove(shareIds: ReadonlySet<string>): void {
    if (this.entries.some((entry) => shareIds.has(entry.shareId))) {
      this.write(this.entries.filter((entry) => !shareIds.has(entry.shareId)))
    }
  }

  /** Every write so far is on disk. */
  flushed(): Promise<void> {
    return this.writes
  }

  private write(entries: SharedBotHostEntry[]): void {
    this.entries = entries
    const contents = JSON.stringify({ v: 1, shares: entries }, null, 2)
    this.writes = this.writes
      .then(() => writeSecureFileAsync(this.path, contents))
      .then(
        () => undefined,
        (error: unknown) => console.warn('[shared-agents] could not save shared agents', error)
      )
  }
}
