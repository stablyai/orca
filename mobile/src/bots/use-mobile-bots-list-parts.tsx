import type { ReactElement } from 'react'
import type { HostScreenController } from '../host-screen/use-host-screen-controller'
import type {
  Section,
  Worktree,
  WorktreeRowView
} from '../worktree/workspace-list/workspace-list-types'
import { MobileBotsListEnd, MobileBotsSectionHeader } from './MobileBotsSectionHeader'
import { MobileBotGroupRow } from './MobileBotHomeRow'
import { MobileBotChatLoading, MobileBotChatPaging, MobileBotChatRow } from './MobileBotChatRows'
import { useMobileBotGroupEditor } from './use-mobile-bot-group-editor'

/** A row of the Bots list, which draws its own dividers: above each bot or group after the first,
 *  none between a bot's chats and lines, which nest by indent alone, as the desktop's do. */
export function isBotsListRow(view: WorktreeRowView | undefined): boolean {
  return Boolean(
    view &&
    (view.botFacts ||
      view.botGroupFacts ||
      view.botWorkspace ||
      view.botChat ||
      view.botChatPaging ||
      view.botChatLoading)
  )
}

/** The host list's bot parts: the Bots header and its "+", its end lines, group rows, and the group sheets. */
export function useMobileBotsListParts(controller: HostScreenController) {
  const groupEditor = useMobileBotGroupEditor(controller)
  const { newBot } = controller
  /** The Bots header for its section; null for every other section. */
  const header = (
    section: Section,
    collapsedKeys: ReadonlySet<string>,
    pendingKeys: ReadonlySet<string>,
    toggle: (collapseKey: string) => void,
    first: boolean
  ): ReactElement | null => {
    if (!section.title || !section.botPreview) {
      return null
    }
    const collapseKey = section.collapseKey ?? section.key
    const newBotHostId = section.newBotHostId
    // One "+" for every computer: New bot picks where it runs; New group is this computer's.
    const onNew = () =>
      groupEditor.chooseNew(() => newBot.open(newBotHostId ?? null), section.botCount ?? 0)
    return (
      <MobileBotsSectionHeader
        section={section}
        collapsed={collapsedKeys.has(collapseKey)}
        pending={pendingKeys.has(collapseKey)}
        first={first}
        onToggle={() => toggle(collapseKey)}
        onNew={newBotHostId ? onNew : null}
      />
    )
  }
  /** The Bots list's end lines, unless it is folded; null for every other section. */
  const footer = (section: Section, collapsedKeys: ReadonlySet<string>): ReactElement | null =>
    section.endLines && !collapsedKeys.has(section.collapseKey ?? section.key) ? (
      <MobileBotsListEnd lines={section.endLines} underRows={section.data.length > 0} />
    ) : null
  /** A bot group's row, or a bot's chat or paging row; null for every other row. */
  const groupRow = (
    item: Worktree,
    view: WorktreeRowView,
    isReadOnly: boolean
  ): ReactElement | null => {
    if (view.botChat) {
      return (
        <MobileBotChatRow
          home={item}
          facts={view.botChat}
          dimmed={view.dimmed === true}
          isReadOnly={isReadOnly}
          onOpen={controller.actions.openWorktreeSession}
        />
      )
    }
    if (view.botChatPaging) {
      return <MobileBotChatPaging facts={view.botChatPaging} dimmed={view.dimmed === true} />
    }
    if (view.botChatLoading) {
      return <MobileBotChatLoading dimmed={view.dimmed === true} />
    }
    const groupFacts = view.botGroupFacts
    return groupFacts ? (
      <MobileBotGroupRow
        item={item}
        facts={groupFacts}
        isReadOnly={isReadOnly}
        divider={view.botDivider === true}
        onPress={() => groupEditor.open(groupFacts.group)}
        onLongPress={() => groupEditor.showActions(groupFacts.group)}
      />
    ) : null
  }
  return { header, footer, groupRow, sheets: groupEditor.sheets }
}
