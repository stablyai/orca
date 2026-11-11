import type { RestoredPane } from './restored-pane-start'
import type { TerminalWorkspaceLaunchScope } from '../../orchestration/terminal-authority/structured-sessions/runtime-legacy-worker-terminal-recovery-types'
import { servesWslMovedPaneHistory } from '../../../orcad/orcad-migration-wsl-destination'
import { movedPaneHistorySessionId } from '../../../persistence/migrating-orcad-catalog/orcad-terminal-history-installer'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { HistoryReader } from '../../../daemon/history/restoration/history-reader'
import { getDaemonHistoryDir } from '../../../daemon/launch/daemon-launch-paths'

export async function claimMovedPaneHistorySession(
  resolveWorkspace: (selector: string) => Promise<TerminalWorkspaceLaunchScope>,
  { worktreeId, tabId, leafId }: RestoredPane
): Promise<string | undefined> {
  // Only a WSL host installs moved panes' history; other hosts skip the scope and meta.json reads.
  if (!servesWslMovedPaneHistory()) {
    return undefined
  }
  try {
    const workspace = await resolveWorkspace(`id:${worktreeId}`)
    // Why never over SSH: only this host's own daemon holds the installed history.
    if (workspace.connectionId !== null) {
      return undefined
    }
    const sessionId = movedPaneHistorySessionId(worktreeId, makePaneKey(tabId, leafId))
    const probe = new HistoryReader(getDaemonHistoryDir()).probeRestorableHistory(sessionId)
    return probe.status === 'restorable' ? sessionId : undefined
  } catch {
    // Why: history is best effort; the pane still starts, only without what it showed before.
    return undefined
  }
}
