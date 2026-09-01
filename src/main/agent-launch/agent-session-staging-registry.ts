// Spawn-time staging half of the host-private session record store (U5 §577):
// registrations keyed by launch token, before any provider session binds. Split
// out so both cleanup handles — the desktop pane teardown AND the terminal exit
// that runtime/mobile surfaces have instead — live next to the map they drain,
// together with the bound that stops a surface reporting neither from holding
// launch snapshots for the life of the process.

// Type-only import: erased at runtime, so no import cycle with the store.
import type { StagedLaunchRegistration } from './agent-session-record-store'

/** Concurrent unbound launches are a handful, so this is a leak stop, not a
 *  working limit. Oldest-registered first out: a launch still waiting for its
 *  first provider hook is by construction the newest staged entry. */
export const MAX_STAGED_LAUNCH_REGISTRATIONS = 256

export class AgentSessionStagingRegistry {
  private readonly staged = new Map<string, StagedLaunchRegistration>()

  add(registration: StagedLaunchRegistration): void {
    this.staged.set(registration.launchToken, registration)
    for (const token of Array.from(this.staged.keys())) {
      if (this.staged.size <= MAX_STAGED_LAUNCH_REGISTRATIONS) {
        return
      }
      this.staged.delete(token)
    }
  }

  get(launchToken: string): StagedLaunchRegistration | undefined {
    return this.staged.get(launchToken)
  }

  delete(launchToken: string): boolean {
    return this.staged.delete(launchToken)
  }

  /** Drop unbound staging for a torn-down pane. */
  disposeForPane(paneKey: string): void {
    this.disposeMatching((staged) => staged.paneKey === paneKey)
  }

  /** Drop unbound staging for an exited terminal. Runtime/mobile registrations
   *  carry no stable pane key, so the terminal id is their only cleanup handle. */
  disposeForTerminal(terminalId: string): void {
    this.disposeMatching((staged) => staged.terminalId === terminalId)
  }

  // Staging is small (bounded by concurrent unbound launches), so a scan is
  // cheaper than a second index.
  private disposeMatching(match: (staged: StagedLaunchRegistration) => boolean): void {
    for (const [token, staged] of this.staged) {
      if (match(staged)) {
        this.staged.delete(token)
      }
    }
  }
}
