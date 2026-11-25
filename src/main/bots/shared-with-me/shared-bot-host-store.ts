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
  // A new chat's session once the host started it: the chat the message lands in.
  startedAs: Text.optional(),
  // Kept on this device only, to draw it in its chat and send it again if the host refuses it.
  // Absent in a store written before held messages kept their words.
  text: z.string().default(''),
  // Sealed with it, and kept to send it again.
  attachments: z.array(z.object({ name: Text, contentBase64: z.string() })).optional(),
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

/** The host's last status answer, kept so a host away reads as it last said after a restart too. */
const KeptStatus = z.object({
  runtimeId: Text,
  runtimeProtocolVersion: z.number().int().optional(),
  minCompatibleRuntimeClientVersion: z.number().int().optional(),
  capabilities: z.array(z.string()).optional(),
  appVersion: z.string().optional()
})
export type SharedBotKeptStatus = z.infer<typeof KeptStatus>

// A phone of this computer's that the host gave a key of its own: `removed` once the phone was unpaired
// here, until the host has ended that key.
const SharedBotPhone = z.object({
  phoneDeviceId: Text,
  hostDeviceId: Text,
  removed: z.literal(true).optional()
})
export type SharedBotPhone = z.infer<typeof SharedBotPhone>

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
  status: KeptStatus.optional(),
  held: z.array(SharedBotHeldMessage),
  // Absent in a store from before phones reached shared agents.
  phones: z.array(SharedBotPhone).default([])
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
    held: [],
    phones: []
  }
}

/** The key held messages are sealed to: the host's own, from its offer, once paired; before that,
 *  only the cloud's word for it. */
export function sharedBotHostKey(
  entry: Pick<SharedBotHostEntry, 'offer' | 'hostKey'>
): string | undefined {
  return entry.offer?.hostPublicKeyB64 ?? entry.hostKey
}

const SharedBotHostsFile = z.object({
  v: z.literal(1),
  shares: z.array(z.unknown()),
  // Shares this account declined: never offered again. Absent in a file from before.
  declined: z.array(BotShareIdSchema).max(1000).catch([]).default([])
})

/** Entry by entry, so one this build can't read is dropped, never the whole file. */
function parseFile(text: string): { entries: SharedBotHostEntry[]; declined: string[] } {
  const file = SharedBotHostsFile.safeParse(JSON.parse(text))
  return file.success
    ? {
        entries: file.data.shares.flatMap(
          (entry) => SharedBotHostEntry.safeParse(entry).data ?? []
        ),
        declined: file.data.declined
      }
    : { entries: [], declined: [] }
}

/** Read once at start; every change is kept in memory at once and written behind, in order. */
export class SharedBotHostStore {
  private readonly path: string
  private entries: SharedBotHostEntry[] = []
  private declinedIds = new Set<string>()
  private writes: Promise<void> = Promise.resolve()
  // Hosts whose share ended this launch: their calls still answer, as no longer shared.
  private readonly removed = new Set<string>()

  constructor(userDataPath: string) {
    this.path = join(userDataPath, SHARED_BOT_HOSTS_FILENAME)
  }

  async load(): Promise<void> {
    try {
      const file = parseFile(await readFile(this.path, 'utf8'))
      this.entries = file.entries
      this.declinedIds = new Set(file.declined)
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

  /** Keeps the host's status answer with its share; written only when it changed. */
  keepStatus(environmentId: string, status: SharedBotKeptStatus): void {
    const entry = this.entries.find((other) => other.environmentId === environmentId)
    const kept = KeptStatus.safeParse(status).data
    if (entry && kept && JSON.stringify(entry.status) !== JSON.stringify(kept)) {
      this.put({ ...entry, status: kept })
    }
  }

  remove(shareIds: ReadonlySet<string>): void {
    for (const entry of this.entries.filter((candidate) => shareIds.has(candidate.shareId))) {
      this.removed.add(entry.environmentId)
    }
    if (this.entries.some((entry) => shareIds.has(entry.shareId))) {
      this.write(this.entries.filter((entry) => !shareIds.has(entry.shareId)))
    }
  }

  /** Keeps that this account declined the share, so it is never offered again. */
  decline(shareId: string): void {
    if (!this.declinedIds.has(shareId)) {
      this.declinedIds.add(shareId)
      this.write(this.entries)
    }
  }

  declined(shareId: string): boolean {
    return this.declinedIds.has(shareId)
  }

  /** Whether `environmentId` named a share this launch removed. */
  wasRemoved(environmentId: string): boolean {
    return this.removed.has(environmentId)
  }

  /** Every write so far is on disk. */
  flushed(): Promise<void> {
    return this.writes
  }

  private write(entries: SharedBotHostEntry[]): void {
    this.entries = entries
    const declined = [...this.declinedIds]
    const contents = JSON.stringify({ v: 1, shares: entries, declined }, null, 2)
    this.writes = this.writes
      .then(() => writeSecureFileAsync(this.path, contents))
      .then(
        () => undefined,
        (error: unknown) => console.warn('[shared-agents] could not save shared agents', error)
      )
  }
}
