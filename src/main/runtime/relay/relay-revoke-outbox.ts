import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readNodeFileSyncWithinLimit } from '../../../shared/node-bounded-file-reader'
import { JsonStringifyByteLimitError } from '../../../shared/node-bounded-json-stringify'
import { writeSecureJsonFileWithinLimit } from '../../../shared/bounded-secure-json-file'
import { hardenExistingSecureFile } from '../../../shared/secure-file'

export type RelayDeviceBinding = {
  relayHostId: string
  relayDeviceId: string
  ownerIdentityKey: string
  inviteExpiresAt?: number
}

export type RelayRevokeOutboxItem = RelayDeviceBinding & {
  reqId: string
  createdAt: number
}

const OUTBOX_FILENAME = 'mobile-relay-revoke-outbox.json'
export const MAX_RELAY_REVOKE_OUTBOX_FILE_BYTES = 1024 * 1024
export const MAX_RELAY_REVOKE_OUTBOX_ITEMS = 4096

export class RelayRevokeOutboxCapacityError extends Error {
  constructor() {
    super(`Relay revoke outbox exceeds ${MAX_RELAY_REVOKE_OUTBOX_ITEMS} items`)
    this.name = 'RelayRevokeOutboxCapacityError'
  }
}

function isItem(value: unknown): value is RelayRevokeOutboxItem {
  if (!value || typeof value !== 'object') {
    return false
  }
  const item = value as Partial<RelayRevokeOutboxItem>
  return (
    typeof item.reqId === 'string' &&
    typeof item.relayHostId === 'string' &&
    typeof item.relayDeviceId === 'string' &&
    typeof item.ownerIdentityKey === 'string' &&
    (item.inviteExpiresAt === undefined ||
      (typeof item.inviteExpiresAt === 'number' && Number.isFinite(item.inviteExpiresAt))) &&
    typeof item.createdAt === 'number' &&
    Number.isFinite(item.createdAt)
  )
}

export class RelayRevokeOutbox {
  private readonly path: string
  private items: RelayRevokeOutboxItem[]

  constructor(userDataPath: string) {
    this.path = join(userDataPath, OUTBOX_FILENAME)
    this.items = this.load()
  }

  enqueue(binding: RelayDeviceBinding): RelayRevokeOutboxItem {
    const existing = this.items.find(
      (item) =>
        item.relayHostId === binding.relayHostId &&
        item.relayDeviceId === binding.relayDeviceId &&
        item.ownerIdentityKey === binding.ownerIdentityKey
    )
    if (existing) {
      return existing
    }
    if (this.items.length >= MAX_RELAY_REVOKE_OUTBOX_ITEMS) {
      throw new RelayRevokeOutboxCapacityError()
    }
    const item = { ...binding, reqId: randomUUID(), createdAt: Date.now() }
    const next = [...this.items, item]
    this.save(next)
    this.items = next
    return item
  }

  pendingFor(ownerIdentityKey: string, relayHostId: string): readonly RelayRevokeOutboxItem[] {
    return this.items.filter(
      (item) => item.ownerIdentityKey === ownerIdentityKey && item.relayHostId === relayHostId
    )
  }

  remove(reqId: string): void {
    const next = this.items.filter((item) => item.reqId !== reqId)
    if (next.length === this.items.length) {
      return
    }
    this.save(next)
    this.items = next
  }

  private load(): RelayRevokeOutboxItem[] {
    if (!existsSync(this.path)) {
      return []
    }
    let parsed: unknown
    try {
      hardenExistingSecureFile(this.path)
      parsed = JSON.parse(
        readNodeFileSyncWithinLimit(this.path, MAX_RELAY_REVOKE_OUTBOX_FILE_BYTES).buffer.toString(
          'utf8'
        )
      )
    } catch {
      return []
    }
    if (!Array.isArray(parsed)) {
      return []
    }
    const items = parsed.filter(isItem)
    if (items.length > MAX_RELAY_REVOKE_OUTBOX_ITEMS) {
      // Why: silently dropping durable revocations could leave remote credentials active.
      throw new RelayRevokeOutboxCapacityError()
    }
    return items
  }

  private save(items: RelayRevokeOutboxItem[]): void {
    try {
      writeSecureJsonFileWithinLimit(this.path, items, MAX_RELAY_REVOKE_OUTBOX_FILE_BYTES)
    } catch (error) {
      if (error instanceof JsonStringifyByteLimitError) {
        throw new RelayRevokeOutboxCapacityError()
      }
      throw error
    }
  }
}
