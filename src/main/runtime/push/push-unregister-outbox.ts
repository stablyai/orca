// Why: a phone that turns background notifications off, or gets unpaired, must
// have its token deleted at the gateway even if the gateway is unreachable right
// then. Modelled on relay-revoke-outbox.ts: durable, hardened, drained on start.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hardenExistingSecureFile, writeSecureJsonFile } from '../../../shared/secure-file'

export type PushUnregisterOutboxItem = {
  reqId: string
  registrationId: string
  deviceId: string
  createdAt: number
}

const OUTBOX_FILENAME = 'mobile-push-unregister-outbox.json'

function isItem(value: unknown): value is PushUnregisterOutboxItem {
  if (!value || typeof value !== 'object') {
    return false
  }
  const item = value as Partial<PushUnregisterOutboxItem>
  return (
    typeof item.reqId === 'string' &&
    typeof item.registrationId === 'string' &&
    item.registrationId.length > 0 &&
    typeof item.deviceId === 'string' &&
    typeof item.createdAt === 'number' &&
    Number.isFinite(item.createdAt)
  )
}

export class PushUnregisterOutbox {
  private readonly path: string
  private items: PushUnregisterOutboxItem[]

  constructor(userDataPath: string) {
    this.path = join(userDataPath, OUTBOX_FILENAME)
    this.items = this.load()
  }

  enqueue(entry: { registrationId: string; deviceId: string }): PushUnregisterOutboxItem {
    const existing = this.items.find((item) => item.registrationId === entry.registrationId)
    if (existing) {
      return existing
    }
    const item = { ...entry, reqId: randomUUID(), createdAt: Date.now() }
    const next = [...this.items, item]
    this.save(next)
    this.items = next
    return item
  }

  pending(): readonly PushUnregisterOutboxItem[] {
    return this.items
  }

  remove(reqId: string): void {
    const next = this.items.filter((item) => item.reqId !== reqId)
    if (next.length === this.items.length) {
      return
    }
    this.save(next)
    this.items = next
  }

  private load(): PushUnregisterOutboxItem[] {
    if (!existsSync(this.path)) {
      return []
    }
    try {
      hardenExistingSecureFile(this.path)
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf-8'))
      return Array.isArray(parsed) ? parsed.filter(isItem) : []
    } catch {
      return []
    }
  }

  private save(items: readonly PushUnregisterOutboxItem[]): void {
    writeSecureJsonFile(this.path, items)
  }
}
