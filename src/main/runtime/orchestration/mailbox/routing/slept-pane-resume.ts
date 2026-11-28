import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { RuntimeMailWakeAdmission } from './runtime-mail-wake-admission'

export type SleptPaneResume = {
  /** Only checks the pane can be resumed; starts nothing. */
  prepareOnly?: boolean
  /** A mail wake's attempt id: the resumed process launches under it. */
  launchToken?: string
}

/** One resume for a slept pane, whatever asked: main starts a pane its layout owns, with or without a
 *  window; the window resumes the rest. */
export abstract class RuntimeSleptPaneResume extends RuntimeMailWakeAdmission {
  /** True when the pane's agent was started, or for `prepareOnly`, when it can be. */
  protected async resumeSleptPaneTerminal(
    worktreeId: string,
    paneKey: string,
    opts: SleptPaneResume = {}
  ): Promise<boolean> {
    const pane = parsePaneKey(paneKey)
    if (!pane || !this.mainHoldsSleptPane(worktreeId, paneKey)) {
      // Main starts a pane it holds with no window; the window must have restored for the rest.
      if (opts.prepareOnly && this.graphStatus !== 'ready') {
        throw new Error('Window is still restoring')
      }
      const resumed = this.notifier?.resumeSleepingAgents?.(
        worktreeId,
        paneKey,
        opts.prepareOnly,
        opts.launchToken
      )
      return (await resumed) === true
    }
    if (opts.prepareOnly) {
      return true
    }
    const target = { worktreeId, tabId: pane.tabId, leafId: pane.leafId }
    const trigger = opts.launchToken ? { launchToken: opts.launchToken } : {}
    // Null when the pane closed meanwhile: there is nothing left to start.
    const started = await this.ensureRestoredPaneStarted(target, trigger).catch(() => null)
    return started !== null
  }
}
