// Decides when an installed copy is brought up to date without a click: a runtime that follows its
// latest release retries hourly in memory; one kept at its pin remembers attempts on disk.

import type {
  ManagedRuntimeInstallState,
  ManagedRuntimeOperation
} from '../../shared/agent-launch/installation/managed-runtime-install'
import { autoUpdateRecordFile, PinnedRuntimeAutoUpdate } from './managed-runtime-auto-update'
import type {
  InstalledRuntimeReleases,
  ManagedRuntime,
  ManagedRuntimePin
} from './managed-runtime-release'

const LATEST_RETRY_MS = 60 * 60_000

/** What the updater reads from, and starts installs on, in its installation. */
export type AutoUpdateHost = {
  enabled(): boolean
  busy(): boolean
  /** Fresh status; `source` says whether new chats run Orca's copy. */
  status(): Promise<ManagedRuntimeInstallState>
  releases(pin: ManagedRuntimePin | null): InstalledRuntimeReleases
  install(): ManagedRuntimeOperation
}

export class ManagedRuntimeAutoUpdater {
  /** One attempt per release per hour, so a failing update isn't redownloaded on every use. */
  private lastLatest: { version: string; at: number } | null = null
  private readonly pinned: PinnedRuntimeAutoUpdate | null

  constructor(
    private readonly runtime: ManagedRuntime,
    root: string,
    private readonly host: AutoUpdateHost
  ) {
    this.pinned = runtime.updatesToPin
      ? new PinnedRuntimeAutoUpdate(autoUpdateRecordFile(root))
      : null
  }

  /** Bring Orca's own copy to the latest or pinned release; never installs one nobody asked for,
   *  touches a user's own, or updates a copy new chats don't run (another program, a signed-in agy). */
  async updateIfBehind(publishedRelease: () => Promise<boolean>): Promise<void> {
    const { runtime, host, pinned } = this
    if ((!runtime.refreshPin && !pinned) || host.busy() || !host.enabled()) {
      return
    }
    // Nothing installed has nothing to update, so the latest release isn't looked up.
    if (!(await publishedRelease())) {
      return
    }
    const state = await host.status()
    if (
      state.source !== 'managed' ||
      state.installedVersion === null ||
      !state.available ||
      state.version === null ||
      state.installedCurrent ||
      host.busy()
    ) {
      return
    }
    if (pinned) {
      const pin = runtime.pin()
      if (pin && (await pinned.take(pin, host.releases(pin))) && !host.busy()) {
        pinned.started(host.install().id)
      }
      return
    }
    const last = this.lastLatest
    if (last?.version === state.version && Date.now() - last.at < LATEST_RETRY_MS) {
      return
    }
    this.lastLatest = { version: state.version, at: Date.now() }
    host.install()
  }

  /** Whether clients may leave Update out: a pinned update that will still run by itself. */
  async pending(
    state: Pick<ManagedRuntimeInstallState, 'source'>,
    releases: InstalledRuntimeReleases
  ) {
    return (
      this.host.enabled() &&
      state.source === 'managed' &&
      (await this.pinned?.pending(this.runtime.pin(), releases)) === true
    )
  }

  /** The automatic install of the pin running now, which the kill switch may stop. */
  isAutomatic(operationId: string): boolean {
    return this.pinned?.running() === operationId
  }

  settled(operation: ManagedRuntimeOperation, stoppedBySwitch: boolean): Promise<void> {
    return this.pinned?.settled(this.runtime.pin(), operation, stoppedBySwitch) ?? Promise.resolve()
  }

  /** A failed update says the older copy is still the one in use, so it doesn't read as broken. */
  failureText(text: string): string {
    const pin = this.runtime.pin()
    const kept = this.pinned ? this.host.releases(pin).release : null
    return pin && kept && !kept.current
      ? `Couldn't update to ${pin.version}, so ${kept.version} is still in use. ${text}`
      : text
  }
}
