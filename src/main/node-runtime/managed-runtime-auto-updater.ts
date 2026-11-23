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
  /** Started by the automatic check, not the user. */
  automatic?: true
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
}

export class ManagedRuntimeAutoUpdater {
  /** One attempt per release per hour, so a failing update isn't redownloaded on every use. */
  private lastLatest: { version: string; at: number } | null = null
  private readonly pinned: PinnedRuntimeAutoUpdate | null
  /** Whether this process has run its check; until then a due pinned update is still coming. */
  private checked = false

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
    this.checked = true
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
      if (pin && (await pinned.take(pin, state)) && !host.busy()) {
        host.install({ automatic: true })
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

  /** Whether clients may leave Update out: this process's check is still to run and will fetch the pin. */
  async pending(
    state: Pick<ManagedRuntimeInstallState, 'source'> & InstalledRelease
  ): Promise<boolean> {
    return (
      !this.checked &&
      this.host.enabled() &&
      state.source === 'managed' &&
      (await this.pinned?.firstAttemptDue(this.runtime.pin(), state)) === true
    )
  }

  /** Marks a run the check started, and watches the kill switch while it runs. */
  adopt(run: AutomaticRunFlags, options: { automatic: true } | undefined, stop: () => void): void {
    if (options?.automatic) {
      run.automatic = true
      run.unwatch = this.host.watchEnabled?.(stop)
    }
  }

  /** What an automatic install passes the installer. */
  installOptions(run: AutomaticRunFlags): { freeSpaceMarginBytes?: number } {
    return run.automatic ? { freeSpaceMarginBytes: AUTOMATIC_FREE_SPACE_MARGIN_BYTES } : {}
  }

  failed(run: AutomaticRunFlags, error: unknown): void {
    run.finalFailure = isFinalInstallFailure(error) || undefined
  }

  /** Records how a run ended, before the outcome is published, so a status read it prompts sees it. */
  ended(
    run: AutomaticRunFlags,
    kind: ManagedRuntimeOperation['kind'],
    phase: ManagedRuntimeOperation['phase']
  ): Promise<void> {
    run.unwatch?.()
    const outcome: InstallOutcome = {
      kind,
      phase,
      automatic: run.automatic === true,
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
