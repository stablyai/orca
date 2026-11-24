// A teammate's phone's share credential on Orca Cloud: installed by hash before the phone gets its
// grant, and removed when the phone loses its key. A removal the cloud didn't take waits in an outbox
// and is tried again, as Relay credential revokes are; a hello that drops the share removes it too.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as z from 'zod'
import { shareDevicePath, UNKNOWN_SHARE_REFUSAL } from '../../../shared/connector-share-contract'
import { writeSecureFileAsync } from '../../../shared/secure-storage/secure-file-async-write'
import type { ConnectorCloud } from '../../connector-cloud/connector-cloud'
import type { ConnectorResult } from '../../connector-cloud/connector-cloud-request'

export type BotSharePhoneCredential = { botId: string; shareId: string; deviceId: string }

type Cloud = Pick<ConnectorCloud, 'call'>

/** The one call the outbox makes: a DELETE that answers nothing. */
export type CredentialRemovalCloud = {
  call: (
    path: string,
    body: undefined,
    schema: z.ZodUndefined,
    options: { method: 'DELETE' }
  ) => Promise<ConnectorResult<undefined>>
}

/** Installs (or replaces) the phone's credential hash; the phone may hold messages once this is true. */
export async function installBotSharePhoneCredential(
  cloud: Cloud | null,
  phone: BotSharePhoneCredential,
  credentialHash: string
): Promise<boolean> {
  const sent = cloud
    ? await cloud.call(
        shareDevicePath(phone.botId, phone.shareId, phone.deviceId),
        { v: 1, credentialHash },
        z.undefined(),
        { method: 'PUT' }
      )
    : null
  return sent?.ok === true
}

const OUTBOX_FILENAME = 'bot-share-phone-credential-outbox.json'
// While a removal waits, it is tried again this often (and whenever another is queued).
const RETRY_MS = 5 * 60 * 1000

const Item = z.object({
  botId: z.string().min(1),
  shareId: z.string().min(1),
  deviceId: z.string().min(1)
})

export class BotSharePhoneCredentialOutbox {
  private readonly path: string
  private items: BotSharePhoneCredential[] = []
  private loaded: Promise<void> | null = null
  private writes: Promise<void> = Promise.resolve()
  private draining: Promise<void> | null = null
  // A removal queued while a drain was out: that drain goes round once more for it.
  private drainAgain = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    userDataPath: string,
    private readonly cloud: () => CredentialRemovalCloud | null
  ) {
    this.path = join(userDataPath, OUTBOX_FILENAME)
  }

  /** Queues the removal durably, then tries it at once. */
  async remove(phone: BotSharePhoneCredential): Promise<void> {
    await this.load()
    await this.save((items) =>
      items.some((item) => item.deviceId === phone.deviceId) ? null : [...items, phone]
    )
    void this.drain()
  }

  /** Every queued removal the cloud has now taken is gone from the outbox. */
  drain(): Promise<void> {
    if (this.draining) {
      this.drainAgain = true
      return this.draining
    }
    this.draining = (async () => {
      try {
        do {
          this.drainAgain = false
          await this.drainOnce()
        } while (this.drainAgain)
      } finally {
        this.draining = null
      }
    })()
    return this.draining
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  pending(): readonly BotSharePhoneCredential[] {
    return this.items
  }

  private async drainOnce(): Promise<void> {
    await this.load()
    this.stop()
    const cloud = this.cloud()
    for (const item of this.items) {
      const sent = cloud
        ? await cloud.call(
            shareDevicePath(item.botId, item.shareId, item.deviceId),
            undefined,
            z.undefined(),
            { method: 'DELETE' }
          )
        : null
      // A share the cloud no longer has took its phones' credentials with it.
      if (sent?.ok || (sent && sent.status === 404 && sent.error === UNKNOWN_SHARE_REFUSAL)) {
        await this.save((items) => items.filter((entry) => entry.deviceId !== item.deviceId)).catch(
          (error: unknown) => console.warn('[bots] could not update the credential outbox', error)
        )
      }
    }
    if (this.items.length > 0) {
      this.timer = setTimeout(() => void this.drain(), RETRY_MS)
      this.timer.unref?.()
    }
  }

  // An unreadable outbox starts empty: a removal lost with it still ends when the hello drops the
  // share, and the host refuses a held message from a phone it no longer has meanwhile.
  private load(): Promise<void> {
    this.loaded ??= readFile(this.path, 'utf8')
      .then((text) => z.array(z.unknown()).parse(JSON.parse(text)))
      .then(
        (rows) => {
          this.items = rows.flatMap((row) => Item.safeParse(row).data ?? [])
        },
        () => {
          this.items = []
        }
      )
    return this.loaded
  }

  // Durable before memory takes it, so a failed write leaves the outbox as the disk has it and a retry
  // writes again. One write at a time, each from the items as the last one left them; `update`
  // answers null to leave them as they are.
  private save(
    update: (items: readonly BotSharePhoneCredential[]) => BotSharePhoneCredential[] | null
  ): Promise<void> {
    const write = this.writes.then(async () => {
      const next = update(this.items)
      if (!next) {
        return
      }
      await writeSecureFileAsync(this.path, JSON.stringify(next), { durable: true })
      this.items = next
    })
    this.writes = write.catch(() => {})
    return write
  }
}
