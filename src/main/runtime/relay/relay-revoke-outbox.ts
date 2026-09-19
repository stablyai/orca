import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  hardenExistingSecureFile,
  isUnreadableError,
  writeSecureJsonFile
} from '../../../shared/secure-file'

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

/** How long an unlanded revoke keeps forcing the relay online on its own. It is retried forever
 *  regardless; this bounds only its claim on demand. */
export const RELAY_REVOKE_DEMAND_WINDOW_MS = 24 * 60 * 60_000

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
  /** Set when the outbox exists but could not be read, so `items` is not what is on disk. */
  private outboxUnreadable = false

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

  /**
   * The pending revokes that still justify forcing the relay online by themselves.
   *
   * Why this is narrower than `pendingFor`: an item is removed only on a SUCCESSFUL flush, so one
   * the server rejects permanently stays pending forever, and demand counts pending revokes
   * unfiltered by the host's pairing-connection policy. That combination pinned the relay up for
   * the life of the install and defeated a `local-only` pick outright.
   *
   * What deliberately does NOT happen here is giving up on the revoke. The item stays in the
   * outbox and keeps retrying on every connection, because failing to revoke leaves a live
   * credential on the relay and silently discarding that intent is the worse hazard. Only its
   * claim on demand expires: a revoke that has not landed in this long is not going to land
   * because the relay is held open, so holding it open buys nothing and costs the user the
   * setting they chose.
   */
  demandingFor(
    ownerIdentityKey: string,
    relayHostId: string,
    now: number
  ): readonly RelayRevokeOutboxItem[] {
    return this.pendingFor(ownerIdentityKey, relayHostId).filter(
      (item) => now - item.createdAt < RELAY_REVOKE_DEMAND_WINDOW_MS
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
    try {
      hardenExistingSecureFile(this.path)
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf-8'))
      return Array.isArray(parsed) ? parsed.filter(isItem) : []
    } catch (error) {
      // An outbox we were denied is not an empty outbox. Saving [] over it would drop
      // revocations that have not reached the relay, so a revoked device stays live.
      this.outboxUnreadable = isUnreadableError(error)
      return []
    }
  }

  private save(items: readonly RelayRevokeOutboxItem[]): void {
    if (this.outboxUnreadable) {
      throw new Error(
        `Cannot read the relay revoke outbox at ${this.path}: the read failed. Refusing to overwrite it, which would drop pending revocations.`
      )
    }
    writeSecureJsonFile(this.path, items)
  }
}
