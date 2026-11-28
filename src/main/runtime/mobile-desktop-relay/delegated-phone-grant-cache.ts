import {
  DELEGATED_MOBILE_DEVICE_SYNC_MAX_PHONES,
  type DelegatedPhone
} from '../../../shared/remote-runtime/pairing/delegated-mobile-device-contract'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime/remote-runtime-client-error'
import { syncDelegatedPhoneGrants, type DelegatedPhoneGrants } from './delegated-phone-grants'
import type { MobileDesktopRelayHost, MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'
import type { RelayedPhoneServers } from './relayed-phone-servers'

type GrantsEntry = {
  // The phones this sync sent. Syncs to one server go out in order, so once the newest answers,
  // the server holds no other phone of this desktop.
  sent: ReadonlySet<string>
  promise: Promise<DelegatedPhoneGrants>
  settled: boolean
  result?: DelegatedPhoneGrants
}

/** Null when the phone list cannot be read: sending it as empty would revoke every phone. */
export type ListRelayedPhones = () => readonly DelegatedPhone[] | null

/** Each server's delegated phone grants, synced once per fence and shared by racing phones.
 *  A phone dropped here reaches every server that may hold it: now if in contact, else on return. */
export class DelegatedPhoneGrantCache {
  private readonly entries = new Map<string, GrantsEntry>()
  // Last contact per server; unknown until its first status.
  private readonly inContact = new Map<string, boolean>()
  // One revocation check runs per server; a trigger during it runs it once more after.
  private readonly checking = new Set<string>()
  private readonly checkAgain = new Set<string>()
  private readonly stopContactWatch: () => void

  constructor(
    private readonly hosts: MobileDesktopRelayHosts,
    private readonly listPhones: ListRelayedPhones,
    private readonly servers: RelayedPhoneServers
  ) {
    const stopContact = hosts.onStatusChanged((contact) => {
      // WSL's bulk status call carries no contact.
      if (!contact) {
        return
      }
      const wasInContact = this.inContact.get(contact.environmentId) === true
      this.inContact.set(contact.environmentId, contact.inContact)
      if (contact.inContact && !wasInContact) {
        this.check(contact.environmentId)
      }
    })
    this.stopContactWatch = stopContact
    this.forgetUnconfiguredServers()
  }

  delete(environmentId: string): void {
    this.entries.delete(environmentId)
    this.inContact.delete(environmentId)
  }

  dispose(): void {
    this.stopContactWatch()
    this.entries.clear()
    this.inContact.clear()
  }

  /** Paired phones changed (or became readable): servers that may still hold a dropped phone get
   *  the new list now. Added phones sync on their first relayed request. */
  phonesChanged(): void {
    const phones = this.listPhones()
    if (!phones) {
      return
    }
    const listed = new Set(phones.map((phone) => phone.phoneKey))
    const checked = new Set<string>()
    for (const [environmentId, entry] of this.entries) {
      if ([...entry.sent].some((phoneKey) => !listed.has(phoneKey))) {
        checked.add(environmentId)
        this.check(environmentId)
      }
    }
    // Recorded servers with no answer here: a failed sync, or contact before phones were readable.
    void this.servers.list().then((environmentIds) => {
      for (const environmentId of environmentIds) {
        const entry = this.entries.get(environmentId)
        if (!checked.has(environmentId) && (!entry || entry.result?.kind === 'update-needed')) {
          this.check(environmentId)
        }
      }
    })
  }

  /** `phoneKey: null` accepts any answered sync; a phone the sync never asked about re-syncs. */
  get(host: MobileDesktopRelayHost, phoneKey: string | null): Promise<DelegatedPhoneGrants> {
    const cached = this.entries.get(host.environmentId)
    if (cached && !cached.settled) {
      // A phone paired since that sync went out was not asked about: look again once it answers.
      return cached.promise.then((grants) =>
        grants.fence === host.fence &&
        (grants.kind !== 'ready' || phoneKey === null || grants.asked.has(phoneKey))
          ? grants
          : this.get(host, phoneKey)
      )
    }
    const answered =
      cached?.result?.kind === 'ready' &&
      cached.result.fence === host.fence &&
      (phoneKey === null || cached.result.asked.has(phoneKey))
    // Never cache update-needed: in-place server upgrades must work without re-pairing.
    return answered && cached.result ? Promise.resolve(cached.result) : this.sync(host)
  }

  // Whether the server may hold a phone no longer listed. Unknown servers hold one only if recorded.
  private async needsSync(environmentId: string): Promise<boolean> {
    const phones = this.listPhones()
    // Out of contact: the check on its return covers it.
    if (!phones || this.inContact.get(environmentId) === false) {
      return false
    }
    const entry = this.entries.get(environmentId)
    // An older server answered nothing about phones; one upgraded in place is checked again.
    if (!entry || entry.result?.kind === 'update-needed') {
      return await this.servers.has(environmentId)
    }
    const listed = new Set(phones.map((phone) => phone.phoneKey))
    return [...entry.sent].some((phoneKey) => !listed.has(phoneKey))
  }

  private check(environmentId: string): void {
    if (this.checking.has(environmentId)) {
      this.checkAgain.add(environmentId)
      return
    }
    this.checking.add(environmentId)
    void this.runChecks(environmentId)
  }

  private async runChecks(environmentId: string): Promise<void> {
    try {
      do {
        this.checkAgain.delete(environmentId)
        try {
          if (await this.needsSync(environmentId)) {
            const host = await this.hosts.resolve(environmentId)
            // A relayed request may have sent the list while this resolved the server.
            if (host && (await this.needsSync(environmentId))) {
              await this.sync(host)
            }
          }
        } catch {
          // Unreachable: the server stays recorded, so its return or the next change retries.
        }
      } while (this.checkAgain.has(environmentId))
    } finally {
      // Same continuation as the last check-again read, so no trigger lands in between.
      this.checking.delete(environmentId)
      this.checkAgain.delete(environmentId)
    }
  }

  private sync(host: MobileDesktopRelayHost): Promise<DelegatedPhoneGrants> {
    const phones = this.listPhones()
    if (!phones) {
      return Promise.reject(
        new RemoteRuntimeClientError(
          'remote_runtime_unavailable',
          'This computer cannot read its paired phones right now.'
        )
      )
    }
    const { environmentId } = host
    const sent = new Set(
      phones.slice(0, DELEGATED_MOBILE_DEVICE_SYNC_MAX_PHONES).map((phone) => phone.phoneKey)
    )
    const previous = this.entries.get(environmentId)?.promise.catch(() => undefined)
    const entry: GrantsEntry = {
      sent,
      promise: previous
        ? previous.then(() => this.send(host, phones, sent))
        : this.send(host, phones, sent),
      settled: false
    }
    this.entries.set(environmentId, entry)
    entry.promise.then(
      (result) => {
        entry.settled = true
        entry.result = result
        // Holds none of this desktop's phones now, unless a newer sync went out meanwhile.
        if (
          result.kind === 'ready' &&
          sent.size === 0 &&
          this.entries.get(environmentId) === entry
        ) {
          void this.servers.set(environmentId, false).catch(() => {})
        }
      },
      () => {
        // Unreachability is no answer; the next request, phone change or contact retries.
        if (this.entries.get(environmentId) === entry) {
          this.entries.delete(environmentId)
        }
      }
    )
    return entry.promise
  }

  private send(
    host: MobileDesktopRelayHost,
    phones: readonly DelegatedPhone[],
    sent: ReadonlySet<string>
  ): Promise<DelegatedPhoneGrants> {
    return syncDelegatedPhoneGrants(this.hosts, host, phones, async () => {
      // Recorded durably first: a phone minted there must stay revocable after a restart.
      if (sent.size > 0) {
        await this.servers.set(host.environmentId, true)
      }
    })
  }

  // Once per launch: a server removed since (here or by the CLI) is pruned at the next one.
  private forgetUnconfiguredServers(): void {
    void this.servers
      .list()
      .then(async (recorded) => {
        const { configuredIds } = this.hosts
        if (recorded.length > 0 && configuredIds) {
          await this.servers.retain(async () => new Set(await configuredIds()))
        }
      })
      .catch(() => {})
  }
}
