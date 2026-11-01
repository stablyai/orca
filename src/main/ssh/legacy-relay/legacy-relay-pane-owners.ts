/** Remember owners across reconnects by endpoint plus incarnation: pty-N ids repeat across relays and restarts. Never serve a replacement process under a known id. COMPAT(legacy-relay-bridge): revisit 2027-01-15. */
import type { LegacyRelayClient } from './legacy-relay-client'
import { isEpochScopedRelayPtyId } from '../../../shared/ssh-pending-pty-kill'

type Owner = {
  endpoint: string
  incarnationId: string | undefined
  /** Its endpoint listed another process under the id, so that relay's silence proves nothing. */
  replaced?: true
  /** The last connection to list the owning process may report its exit. */
  client?: LegacyRelayClient
}

type LegacyRelayOwnerRow = {
  endpoint: string
  incarnationId?: string | undefined
  client?: LegacyRelayClient
}

export class LegacyRelayPaneOwners {
  /** Null permanently rejects an id claimed by two relays before ownership was known. */
  private readonly owners = new Map<string, Owner | null>()
  /** Exit reports by relay endpoint, until the next listing reads or drops them. */
  private readonly unclaimedExits = new Map<string, number>()

  owner(relayPtyId: string): string | null | undefined {
    const owner = this.owners.get(relayPtyId)
    return owner === undefined ? undefined : (owner?.endpoint ?? null)
  }

  /** Whether `row` is the owner's own process; relays that report no incarnation can't be told apart. */
  isOwnerProcess(relayPtyId: string, row: LegacyRelayOwnerRow): boolean {
    const owner = this.owners.get(relayPtyId)
    return owner?.endpoint === row.endpoint && owner.incarnationId === row.incarnationId
  }

  /** Trust the connection that listed this process; reopened endpoints may reuse ids after restart. Epoch-scoped ids retain identity across connections. */
  speaksFor(relayPtyId: string, endpoint: string, client: LegacyRelayClient): boolean {
    const owner = this.owners.get(relayPtyId)
    if (!owner || owner.replaced || owner.endpoint !== endpoint) {
      return false
    }
    return isEpochScopedRelayPtyId(relayPtyId) || owner.client === client
  }

  bind(relayPtyId: string, row: LegacyRelayOwnerRow): void {
    const owner = this.owners.get(relayPtyId) ?? {
      endpoint: row.endpoint,
      incarnationId: row.incarnationId
    }
    this.owners.set(relayPtyId, row.client ? { ...owner, client: row.client } : owner)
  }

  claimContested(relayPtyId: string): void {
    this.owners.set(relayPtyId, null)
  }

  /** A replacement at the same endpoint cannot prove the original process exited. */
  markReplaced(relayPtyId: string): void {
    const owner = this.owners.get(relayPtyId)
    if (owner) {
      owner.replaced = true
    }
  }

  isReplaced(relayPtyId: string): boolean {
    return Boolean(this.owners.get(relayPtyId)?.replaced)
  }

  forget(relayPtyId: string): void {
    this.owners.delete(relayPtyId)
  }

  /** Retain exits until listing binds ownership; key by endpoint so reopening does not lose earlier reports. */
  noteExit(relayPtyId: string, endpoint: string, code: number): void {
    this.unclaimedExits.set(`${endpoint}\n${relayPtyId}`, code)
  }

  exitBeforeListing(relayPtyId: string, endpoint: string): number | undefined {
    return this.unclaimedExits.get(`${endpoint}\n${relayPtyId}`)
  }

  /** Discard reports the completed listing could not attribute. */
  clearExits(): void {
    this.unclaimedExits.clear()
  }
}
