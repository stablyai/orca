// A teammate's phone's share credential on Orca Cloud: installed by hash before the phone gets its
// grant, and removed when the phone loses its key. A removal the cloud didn't take waits in an outbox
// and is tried again, as Relay credential revokes are; a hello that drops the share removes it too.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as z from 'zod'
import { shareDevicePath, UNKNOWN_SHARE_REFUSAL } from '../../../shared/connector-share-contract'
import { writeSecureFileAsync } from '../../../shared/secure-storage/secure-file-async-write'
import type { ConnectorCloud } from '../../connector-cloud/connector-cloud'

export type BotSharePhoneCredential = { botId: string; shareId: string; deviceId: string }

type Cloud = Pick<ConnectorCloud, 'call'>

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
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    userDataPath: string,
    private readonly cloud: () => Cloud | null
  ) {
    this.path = join(userDataPath, OUTBOX_FILENAME)
  }

  /** Queues the removal durably, then tries it at once. */
  async remove(phone: BotSharePhoneCredential): Promise<void> {
    await this.load()
    if (!this.items.some((item) => item.deviceId === phone.deviceId)) {
      await this.write([...this.items, phone])
    }
    void this.drain()
  }

  /** Every queued removal the cloud has now taken is gone from the outbox. */
  drain(): Promise<void> {
    this.draining ??= this.drainOnce().finally(() => {
      this.draining = null
    })
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
        await this.write(this.items.filter((entry) => entry.deviceId !== item.deviceId))
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

  // Durable before the drain trusts it; one write at a time, in order.
  private write(items: BotSharePhoneCredential[]): Promise<void> {
    this.items = items
    const contents = JSON.stringify(items)
    const write = this.writes.then(async () => {
      await writeSecureFileAsync(this.path, contents, { durable: true })
    })
    this.writes = write.catch(() => {})
    return write
  }
}
