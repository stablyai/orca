import type {
  SpotlightChangedEvent,
  SpotlightOpResult,
  SpotlightStateSnapshot
} from '../../shared/spotlight'

export type SpotlightApi = {
  /** Main is the source of truth; the renderer hydrates this snapshot at startup. */
  getState: () => Promise<SpotlightStateSnapshot>
  /** Activate for a worktree. Re-activating the current holder re-syncs;
   *  activating from another worktree of the same repo is a takeover. */
  activate: (args: { repoId: string; worktreeId: string }) => Promise<SpotlightOpResult>
  /** Re-sync the current holder's changes onto the root. */
  sync: (args: { repoId: string; force?: boolean }) => Promise<SpotlightOpResult>
  /** Release the Spotlight and restore the root's original state. */
  deactivate: (args: { repoId: string; discardBackup?: boolean }) => Promise<SpotlightOpResult>
  /** Mirror this PTY's output to <root>/.orca/spotlight.log (the workspace's
   *  Spotlight terminal) so agents in any worktree can read server logs. */
  setLogPty: (args: { repoId: string; ptyId: string }) => Promise<void>
  clearLogPty: (args: { repoId: string; ptyId?: string }) => Promise<void>
  onChanged: (callback: (event: SpotlightChangedEvent) => void) => () => void
}
