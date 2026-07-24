import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hardenExistingSecureFile, writeSecureJsonFile } from '../../../shared/secure-file'

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
    const item = { ...binding, reqId: randomUUID(), createdAt: Date.now() }
    this.items.push(item)
    this.save()
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
    this.items = next
    this.save()
  }

  private load(): RelayRevokeOutboxItem[] {
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

  private save(): void {
    writeSecureJsonFile(this.path, this.items)
  }
}
