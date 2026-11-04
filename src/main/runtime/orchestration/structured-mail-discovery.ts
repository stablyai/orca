import type { StructuredMailboxParking } from './structured-mailbox-parking'
import type { MessageRow, OrchestrationDb } from './db'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import type {
  StructuredMailEligibility,
  StructuredMailboxPointerHost
} from './structured-mailbox-pointer-host-contract'
import type { StructuredPointerTarget } from './structured-mailbox-pointer-delivery'

type MailScope = StructuredMailEligibility & StructuredPointerTarget & { db: OrchestrationDb }

/** Only an unfinished discovery retains its bounded page; completed walks retain no row frontier. */
export class MailDiscoveryWalk {
  generation = 0
  pending = true
  held = false
  page: MessageRow[] = []
  afterSequence: number | undefined
  reservedTypes: ReadonlySet<string> | undefined
  private scope: MailScope | undefined
  private exclusions: string | undefined

  request(): void {
    this.generation++
    this.pending = true
    this.held = false
    this.page = []
    this.afterSequence = undefined
  }

  sameAttachment(
    db: OrchestrationDb,
    target: StructuredPointerTarget,
    host: StructuredMailEligibility['host'] | null,
    fence: number | null
  ): boolean {
    const last = this.scope
    return (
      !!last &&
      last.db === db &&
      last.host === host &&
      last.fence === fence &&
      last.sessionId === target.sessionId &&
      last.dispatchId === target.dispatchId
    )
  }

  reconcile(
    db: OrchestrationDb,
    target: StructuredPointerTarget,
    eligibility: StructuredMailEligibility,
    waiters: ReadonlySet<OrchestrationMessageWaiter> | undefined
  ): void {
    const exclusions = JSON.stringify(
      [...(waiters ?? [])]
        .map((waiter) => (waiter.typeFilter ? [...waiter.typeFilter].sort() : null))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    )
    const changed =
      !this.sameAttachment(db, target, eligibility.host, eligibility.fence) ||
      this.scope?.key !== eligibility.key ||
      this.exclusions !== exclusions
    if (changed) {
      this.request()
    }
    this.scope = { db, ...target, ...eligibility }
    this.exclusions = exclusions
  }

  protect(types: ReadonlySet<string> | undefined): void {
    if (!types?.size) {
      return
    }
    const next = new Set([...(this.reservedTypes ?? []), ...types])
    if (next.size !== (this.reservedTypes?.size ?? 0)) {
      this.request()
      this.reservedTypes = next
    }
  }

  relaxReserved(): void {
    this.reservedTypes = undefined
    this.request()
  }

  complete(): void {
    this.pending = false
    this.page = []
    this.afterSequence = undefined
    this.reservedTypes = undefined
  }
}

export class StructuredMailDiscovery {
  private readonly walks = new Map<string, MailDiscoveryWalk>()

  get(mailbox: string): MailDiscoveryWalk {
    let walk = this.walks.get(mailbox)
    if (!walk) {
      walk = new MailDiscoveryWalk()
      this.walks.set(mailbox, walk)
    }
    return walk
  }

  async reconcile(
    mailbox: string,
    walk: MailDiscoveryWalk,
    input: {
      db: OrchestrationDb
      getDb: () => OrchestrationDb | null
      resolveStructuredTarget: (handle: string) => StructuredPointerTarget | null
      host: StructuredMailboxPointerHost
      getMessageWaiters: (handle: string) => ReadonlySet<OrchestrationMessageWaiter> | undefined
      parking: StructuredMailboxParking
      reservedTypes: ReadonlySet<string> | undefined
      retrying: boolean
    }
  ) {
    const valid = () => this.owns(mailbox, walk) && input.db === input.getDb()
    if (!valid()) {
      return null
    }
    const current = input.resolveStructuredTarget(mailbox)
    if (!current) {
      return null
    }
    input.parking.park(mailbox, current.sessionId, input.reservedTypes)
    let eligibility = input.host.readEligibility(current.sessionId)
    // An unchanged completed hold needs no reopen after the normal idle sweep.
    if (
      !eligibility &&
      !walk.pending &&
      !input.retrying &&
      walk.sameAttachment(
        input.db,
        current,
        input.host.attachment(),
        input.host.currentFence(current.sessionId)
      )
    ) {
      return null
    }
    if (!eligibility) {
      await input.host.openEligibility(current.sessionId)
    }
    if (!valid()) {
      return null
    }
    const target = input.resolveStructuredTarget(mailbox)
    eligibility = target && input.host.readEligibility(target.sessionId)
    if (!target || !eligibility) {
      return null
    }
    walk.reconcile(input.db, target, eligibility, input.getMessageWaiters(mailbox))
    return { target, eligibility }
  }

  request(mailbox: string): void {
    this.get(mailbox).request()
  }
  owns(mailbox: string, walk: MailDiscoveryWalk): boolean {
    return this.walks.get(mailbox) === walk
  }
  forget(mailbox: string): void {
    this.walks.delete(mailbox)
  }
  clear(): void {
    this.walks.clear()
  }
}
