// Decides when an installed copy is brought up to date without a click: a runtime that follows its
// latest release retries hourly in memory; one kept at its pin keeps a record on disk.

import type {
  ManagedRuntimeInstallState,
  ManagedRuntimeOperation
} from '../../shared/agent-launch/installation/managed-runtime-install'
import {
  autoUpdateRecordFile,
  PinnedRuntimeAutoUpdate,
  type InstalledRelease,
  type InstallOutcome
} from './managed-runtime-auto-update'
import type { ManagedRuntime } from './managed-runtime-release'
import { isFinalInstallFailure } from './managed-runtime-release-install'

const LATEST_RETRY_MS = 60 * 60_000
// An install nobody asked for keeps this much more free than one the user started: the old release
// stays until the next start (about 1.7 GB under the root on Linux), and the user's own work needs room.
const AUTOMATIC_FREE_SPACE_MARGIN_BYTES = 2 * 1024 ** 3

/** What an install run carries about the automatic check. */
export type AutomaticRunFlags = {
  /** Started by the automatic check and not joined by the user's Update: the kill switch may stop it. */
  automatic?: true
  /** Its attempt was counted when the check took it. */
  counted?: true
  /** Stopped because automatic updates were turned off, not declined by the user. */
  stoppedBySwitch?: true
  /** Failed in a way that will recur, so no automatic attempt follows. */
  finalFailure?: true
  unwatch?: () => void
}

/** What the updater reads from, and starts installs on, in its installation. */
export type AutoUpdateHost = {
  enabled(): boolean
  busy(): boolean
  /** Fresh status; `source` says whether new chats run Orca's copy. */
  status(): Promise<ManagedRuntimeInstallState>
  install(options?: { automatic: true }): ManagedRuntimeOperation
  /** Told when automatic updates are turned off; returns an unsubscribe. */
  watchEnabled?: (onDisabled: () => void) => () => void
  /** Clients re-read status: what it reports has changed without an operation changing. */
  changed(): void
}

export class ManagedRuntimeAutoUpdater {
  /** One attempt per release per hour, so a failing update isn't redownloaded on every use. */
  private lastLatest: { version: string; at: number } | null = null
  private readonly pinned: PinnedRuntimeAutoUpdate | null
  /** Whether this process has run its check; until then a due pinned update is still coming. */
  private checked = false
  /** Whether status told clients an update is pending, so they left Update out. */
  private reportedPending = false

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
   *  touches a user's own, or updates a copy new chats don't run. */
  async updateIfBehind(publishedRelease: () => Promise<boolean>): Promise<void> {
    const { reportedPending } = this
    this.checked = true
    this.reportedPending = false
    const started = await this.check(publishedRelease)
    // A check that installs publishes its operation; one that doesn't must still retire "pending".
    if (reportedPending && !started) {
      this.host.changed()
    }
  }

  /** Whether it started an install. */
  private async check(publishedRelease: () => Promise<boolean>): Promise<boolean> {
    const { runtime, host, pinned } = this
    if ((!runtime.refreshPin && !pinned) || host.busy() || !host.enabled()) {
      return false
    }
    // Nothing installed has nothing to update, so the latest release isn't looked up.
    if (!(await publishedRelease())) {
      return false
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
      return false
    }
    if (pinned) {
      const pin = runtime.pin()
      if (!pin || !(await pinned.take(pin, state)) || host.busy()) {
        return false
      }
      host.install({ automatic: true })
      return true
    }
    const last = this.lastLatest
    if (last?.version === state.version && Date.now() - last.at < LATEST_RETRY_MS) {
      return false
    }
    this.lastLatest = { version: state.version, at: Date.now() }
    host.install()
    return true
  }

  /** Whether clients may leave Update out: this process's check is still to run and will fetch the pin. */
  async pending(
    state: Pick<ManagedRuntimeInstallState, 'source'> & InstalledRelease
  ): Promise<boolean> {
    const pending =
      !this.checked &&
      this.host.enabled() &&
      state.source === 'managed' &&
      (await this.pinned?.firstAttemptDue(this.runtime.pin(), state)) === true
    // Read again: the check may have run while the record was read.
    this.reportedPending ||= pending && !this.checked
    return pending && !this.checked
  }

  /** Marks a run the check started, and watches the kill switch while it runs. */
  adopt(run: AutomaticRunFlags, options: { automatic: true } | undefined, stop: () => void): void {
    if (options?.automatic) {
      run.automatic = true
      run.counted = true
      run.unwatch = this.host.watchEnabled?.(stop)
    }
  }

  /** Stops a run the check started that hasn't published its release; the user's own runs go on. */
  stop(
    run: (AutomaticRunFlags & { committed: boolean; controller: AbortController }) | null
  ): void {
    if (run?.automatic && !run.committed) {
      run.stoppedBySwitch = true
      run.controller.abort()
    }
  }

  /** The user's Update joined this run: it is theirs now, so the kill switch leaves it alone. */
  joined(run: AutomaticRunFlags, options: { automatic: true } | undefined): void {
    if (!options?.automatic && run.automatic) {
      run.automatic = undefined
      run.unwatch?.()
      run.unwatch = undefined
    }
  }

  /** What an automatic install passes the installer. */
  installOptions(run: AutomaticRunFlags): { automaticFreeSpaceMarginBytes?: number } {
    return run.counted ? { automaticFreeSpaceMarginBytes: AUTOMATIC_FREE_SPACE_MARGIN_BYTES } : {}
  }

  failed(run: AutomaticRunFlags, error: unknown): void {
    run.finalFailure = isFinalInstallFailure(error) || undefined
  }

  /** Records how a run ended, before the outcome is published, so a status read it prompts sees it;
   *  also for a run whose outcome is never published because another install replaced it. */
  ended(
    run: AutomaticRunFlags,
    kind: ManagedRuntimeOperation['kind'],
    phase: ManagedRuntimeOperation['phase']
  ): Promise<void> {
    run.unwatch?.()
    run.unwatch = undefined
    const outcome: InstallOutcome = {
      kind,
      phase,
      automatic: run.counted === true,
      stoppedBySwitch: run.stoppedBySwitch === true,
      finalFailure: run.finalFailure === true
    }
    return this.pinned?.settled(this.runtime.pin(), outcome) ?? Promise.resolve()
  }

  forget(): Promise<void> {
    return this.pinned?.forget() ?? Promise.resolve()
  }

  /** A failed update says the older copy is still the one in use, so it doesn't read as broken. */
  failureText(text: string, before: InstalledRelease | null): string {
    const pin = this.runtime.pin()
    const kept = this.pinned && before && !before.installedCurrent ? before.installedVersion : null
    return pin && kept
      ? `Couldn't update to ${pin.version}, so ${kept} is still in use. ${text}`
      : text
  }
}
