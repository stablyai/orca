import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { ConversationNameTab } from '../../../../../shared/agent-status/presentation/agent-row-conversation-name'
import type {
  MirroredTabs,
  SenderNamingLayout,
  TerminalSenderNaming
} from './orchestration-sender-name'

/** Split-tab titles name the focused pane; other split panes need user titles. Single-pane tabs use their own tab titles. */
export function splitPaneTitle(
  layout: SenderNamingLayout | undefined,
  paneKey: string | null
): string | null | undefined {
  if (layout?.root?.type !== 'split') {
    return undefined
  }
  const leafId = paneKey ? parsePaneKey(paneKey)?.leafId : undefined
  return (leafId && layout.titlesByLeafId?.[leafId]) || null
}

export type MirroredPaneTabReader = (
  worktreeId: string,
  tabId: string
) => (Pick<TerminalTab, 'id'> & Partial<ConversationNameTab>) | undefined

/** A pane's mirrored tab and its title: the live tracked title, else its split pane's own title. */
export function mirroredPaneNaming(
  record: { worktreeId: string; tabId: string },
  paneKey: string | null,
  session: MirroredTabs | null | undefined,
  trackedTitle: string | null,
  read: {
    readTab?: MirroredPaneTabReader
    readLayout?: (tabId: string) => SenderNamingLayout | undefined
  }
): Pick<TerminalSenderNaming, 'tab' | 'paneTitle'> {
  const tab = read.readTab
    ? read.readTab(record.worktreeId, record.tabId)
    : session?.tabsByWorktree?.[record.worktreeId]?.find(
        (candidate) => candidate.id === record.tabId
      )
  return {
    tab: tab ? { ...tab, title: tab.title ?? '', customTitle: tab.customTitle ?? null } : null,
    paneTitle:
      trackedTitle ??
      splitPaneTitle(
        read.readLayout
          ? read.readLayout(record.tabId)
          : session?.terminalLayoutsByTabId?.[record.tabId],
        paneKey
      )
  }
}
