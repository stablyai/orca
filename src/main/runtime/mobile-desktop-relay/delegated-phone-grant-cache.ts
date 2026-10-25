import type { DelegatedMobileDeviceSyncParams } from '../../../shared/delegated-mobile-device-contract'
import { syncDelegatedPhoneGrants, type DelegatedPhoneGrants } from './delegated-phone-grants'
import type { MobileDesktopRelayHost, MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'

type GrantsEntry = {
  promise: Promise<DelegatedPhoneGrants>
  settled: boolean
  result?: DelegatedPhoneGrants
}

/** Each server's delegated phone grants, synced once per fence and shared by racing phones. */
export class DelegatedPhoneGrantCache {
  private readonly entries = new Map<string, GrantsEntry>()

  constructor(
    private readonly hosts: MobileDesktopRelayHosts,
    private readonly listPhones: () => DelegatedMobileDeviceSyncParams['phones']
  ) {}

  environmentIds(): string[] {
    return [...this.entries.keys()]
  }

  delete(environmentId: string): void {
    this.entries.delete(environmentId)
  }

  clear(): void {
    this.entries.clear()
  }

  /** `phoneKey: null` accepts any answered sync; a phone the sync never asked about re-syncs. */
  get(host: MobileDesktopRelayHost, phoneKey: string | null): Promise<DelegatedPhoneGrants> {
    const cached = this.entries.get(host.environmentId)
    if (cached && !cached.settled) {
      // Why: phones racing to one server share its sync.
      return cached.promise.then((grants) =>
        grants.fence === host.fence ? grants : this.get(host, phoneKey)
      )
    }
    const answered =
      cached?.result?.kind === 'ready' &&
      cached.result.fence === host.fence &&
      (phoneKey === null || cached.result.asked.has(phoneKey))
    // Why update-needed is never reused: a server upgraded in place must relay without a re-pair.
    return answered && cached.result ? Promise.resolve(cached.result) : this.sync(host)
  }

  private sync(host: MobileDesktopRelayHost): Promise<DelegatedPhoneGrants> {
    const entry: GrantsEntry = {
      promise: syncDelegatedPhoneGrants(this.hosts, host, this.listPhones()),
      settled: false
    }
    this.entries.set(host.environmentId, entry)
    entry.promise.then(
      (result) => {
        entry.settled = true
        entry.result = result
      },
      () => {
        // Why: an unreachable server is not an answer; the next request syncs again.
        if (this.entries.get(host.environmentId) === entry) {
          this.entries.delete(host.environmentId)
        }
      }
    )
    return entry.promise
  }
}
