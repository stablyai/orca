import { sessionFileTabListRead } from '../../../files/session-documents/mobile-source-file-open-operations'
import { activateMobileSessionTab } from '../../../session/tabs/mobile-session-tab-activation'

// The desktop publishes the tab after files.openDiff replies; a few short polls cover that hop.
const TAB_POLL_DELAYS_MS = [0, 300, 600, 900] as const

/** Selects the diff tab "Open in session" opened for this phone only; the desktop keeps its own view (#33052). */
export async function selectOpenedSessionDiff(
  client: Parameters<typeof activateMobileSessionTab>[0],
  target: { worktreeId: string; relativePath: string; staged: boolean },
  isCurrent: () => boolean
): Promise<void> {
  const worktree = `id:${target.worktreeId}`
  const source = target.staged ? 'staged' : 'unstaged'
  for (const delayMs of TAB_POLL_DELAYS_MS) {
    if (delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
    }
    if (!isCurrent()) {
      return
    }
    const listed = sessionFileTabListRead.interpret(
      await sessionFileTabListRead.request(client, { worktree })
    )
    const tab = listed.accepted
      ? listed.value?.tabs.find(
          (candidate) =>
            candidate.mode === 'diff' &&
            candidate.relativePath === target.relativePath &&
            // Branch and commit diffs list no source; they are never this working-tree diff.
            candidate.diffSource === source
        )
      : undefined
    if (tab) {
      await activateMobileSessionTab(client, {
        worktree,
        tabId: tab.id,
        notifyClients: false,
        navigation: 'caller',
        intent: 'user'
      })
      return
    }
  }
}
