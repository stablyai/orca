import type { ExecutionHostId } from '../../../../src/shared/execution-host/execution-host'
import type { RuntimeWorktreePsSummary } from '../../../../src/shared/worktree/catalog/runtime-worktree-contracts'
import type { ProjectSectionRepo } from '../../../../src/shared/sidebar-list/sections/project-section-grouping'
import type { WorkspaceRowFilters } from '../../../../src/shared/workspace-view/workspace-row-filters'
import type { WorktreeStatus } from '../../../../src/shared/worktree/row-display/worktree-status-rollup'
import type {
  MobileBotChatLineFacts,
  MobileBotChatPagingFacts,
  MobileBotChatRowFacts,
  MobileBotGroupRowFacts,
  MobileBotRowFacts
} from '../../bots/host-bot-row-facts'

/** Fields every host the phone pairs with sends; the rest are optional because older hosts omit them. */
type AlwaysSentHostRowField =
  | 'worktreeId'
  | 'repoId'
  | 'repo'
  | 'branch'
  | 'displayName'
  | 'path'
  | 'liveTerminalCount'
  | 'hasAttachedPty'
  | 'unread'
  | 'isPinned'
  | 'linkedPR'

/** The host's worktree.ps row, typed from the shared contract. Phone-only facts go in WorktreeRowView. */
export type Worktree = Pick<RuntimeWorktreePsSummary, AlwaysSentHostRowField> &
  Partial<Omit<RuntimeWorktreePsSummary, AlwaysSentHostRowField | 'sidebarStatus'>> & {
    /** Unchecked wire data: a newer host may send a state this build does not know. */
    sidebarStatus?: string
  }

/** The host context a mixed-host list shows on a row. */
export type WorktreeHostContextView = {
  hostContextLabel?: string
  /** Resolved host for the display label; present when legacy rows omit hostId. */
  hostContextHostId?: ExecutionHostId
  // Omit health labels for healthy hosts.
  hostContextHealthLabel?: string
}

/** Facts the phone works out for a listed row. They sit beside the host's row, never on it, so a
 *  host field of the same name cannot collide with them. */
export type WorktreeRowView = WorktreeHostContextView & {
  sectionListKey?: string
  /** Show the existing project-name surface for a child from another repo. */
  showProjectName?: boolean
  lineageDepth?: number
  // Match the desktop’s project-group row depth.
  projectGroupDepth?: number
  /** Its project group came from a folder scan, whose rows the desktop steps more compactly. */
  inFolderScanGroup?: boolean
  lineageChildCount?: number
  lineageCollapsed?: boolean
  /** The collapse key the shared builder gave this row's children; set only on a feed-built list. */
  lineageGroupKey?: string
  isLastLineageChild?: boolean
  /** Set on a bot's home folder row, which the Bots section draws as the bot. */
  botFacts?: MobileBotRowFacts
  /** Set on a group's hidden home row, which the Bots section draws as the room. */
  botGroupFacts?: MobileBotGroupRowFacts
  botWorkspace?: true
  /** A bot or group row after the first in the Bots list, which draws its own divider above. */
  botDivider?: true
  /** A bot's chat row in the Bots list, drawn over its bot's home row. */
  botChat?: MobileBotChatRowFacts
  /** A chat's worker paging row ("Show 8 more workers · Show fewer"), drawn over its bot's home row. */
  botChatPaging?: MobileBotChatPagingFacts
  /** Holds a bot's place until its first chats read lands, so its rows don't swap under you. */
  botChatLoading?: true
  /** A bot worker's workspace under its chat, drawn as one line. */
  botChatLine?: MobileBotChatLineFacts
  /** Drawn faded, as a paused bot and its workspaces are. */
  dimmed?: true
}

export type WorkspaceListItem = { row: Worktree; view: WorktreeRowView }

/** The desktop's Workspace options filters, one shared value. */
export type FilterState = WorkspaceRowFilters

// Catalog repo or fallback from a workspace row.
// repoIcon stays unread wire data until drawn (readMobileRepoIcon).
export type SectionRepo = ProjectSectionRepo & {
  badgeColor?: string
  repoIcon?: unknown
  projectGroupId?: string | null
  projectGroupOrder?: number
  hiddenAt?: number
}

// Pending creations name only their project; null belongs under the list’s own header.
export type SectionPendingCreation = { key: string; repoName: string | null }

/** One quiet line after a Bots list, keyed by the computer it is about. */
export type BotsListEndLine = { key: string; text: string }

export type Section = {
  /** The list identity; unique even when one header repeats in several host sections. */
  key: string
  /** The view's collapse key when it differs from `key`; a header's copies share it. */
  collapseKey?: string
  title: string
  icon?: 'pin'
  repo?: SectionRepo
  isProjectGroup?: boolean
  projectGroupDepth?: number
  /** The header's own count from a feed-built list, which a collapsed section still shows. */
  count?: number
  pendingCreations?: SectionPendingCreation[]
  /** The computer New bot starts on, when any takes a new bot from this phone: the header offers "+". */
  newBotHostId?: ExecutionHostId
  /** This computer's bots, unfiltered by search: New group needs two of them. */
  botCount?: number
  /** Quiet lines after a Bots list's last row, e.g. a computer too old to list its bots. */
  endLines?: BotsListEndLine[]
  botPreview?: {
    id: string
    name: string
    avatar: MobileBotRowFacts['avatar']
    status: WorktreeStatus
    unread: boolean
    paused: boolean
    attention?: boolean
  }[]
  data: WorkspaceListItem[]
}
