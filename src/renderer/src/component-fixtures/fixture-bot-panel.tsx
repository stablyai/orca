// The bot right panel as fixtures frame it: a sample bot, its page's store, and the sidebar's real tabs over Activity or Chats.
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { withBotConnectorRuntime } from '@/lib/bot-connector-host-calls.test-fixture'
import { useState } from 'react'
import { PanelRight } from 'lucide-react'
import { useAppStore } from '@/store'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import type { AppState } from '@/store/types'
import BotActivityPanel from '@/components/bots/BotActivityPanel'
import BotChatsPanel from '@/components/bots/BotChatsPanel'
import { getTopActivityBarLayout } from '@/components/right-sidebar/activity-bar/activity-bar-overflow'
import { useMeasuredWidth } from '@/components/right-sidebar/layout/right-sidebar-measured-width'
import { measureTabTitle } from '@/components/right-sidebar/right-sidebar-tab-title-width'
import { ActivityBarButton } from '@/components/right-sidebar/activity-bar/activity-bar-buttons'
import { useRightSidebarActivityItems } from '@/components/right-sidebar/activity-bar/use-right-sidebar-activity-items'
import { mascotAvatar } from '../../../shared/bot-avatar'
import type { Bot } from '../../../shared/bot-types'
import type { BotActivity, BotWorkerRow } from '../../../shared/bots/bot-activity-model'
import type { BotAutomationRow } from '../../../shared/bots/bot-automation-rows'
import { suggestionSource, type Suggestion } from '../../../shared/bots/bot-look-around'
import type { AgentDotState } from '../../../shared/agent-dot-state'
import type { BotChatTreeChat } from '../../../shared/bots/bot-chat-tree'
import type { BotItem } from '../../../shared/bots/bot-items'
import type {
  AgentStatusEntry,
  AgentStatusState
} from '../../../shared/agent-status/contracts/agent-status-types'
import { structuredAgentSessionStatusPaneKey } from '../../../shared/agent-session/view/structured-agent-session-tab'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import { stubBots } from './fixture-bots'

export const fixtureCos: Bot = {
  id: 'bot-cos',
  name: 'CoS',
  hostId: 'local',
  folder: 'cos',
  folderWorkspaceId: 'fw-cos',
  agent: 'claude',
  avatar: mascotAvatar('G1'),
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: 'chat-cos',
  createdAt: 1,
  updatedAt: 1
}
const home = folderWorkspaceKey(fixtureCos.folderWorkspaceId)
const METHOD_NOT_FOUND = 'method_not_found'
const now = Date.now()

export function stubBotPanel(
  activity: BotActivity,
  bot: Bot = fixtureCos,
  chats: BotChatTreeChat[] = [],
  /** The bot's items; omitted, the items read answers as the stub's fallback does. */
  items?: BotItem[]
): () => void {
  return () => {
    stubBots([bot])
    // No connector is linked; their reads answer as an unlinked account's do.
    const unlinked = { state: async () => ({ ok: false, error: { code: 'not_linked' } }) }
    for (const api of ['botSlack', 'botLinear', 'botGitHub']) {
      Reflect.set(window.api, api, unlinked)
    }
    const runtime = window.api.runtime
    const fallback = runtime.call
    Reflect.set(window.api, 'runtime', {
      ...runtime,
      call: async (request: Parameters<typeof fallback>[0]) =>
        request.method === 'bots.activity'
          ? { ok: true, result: { activity } }
          : request.method === 'bots.items.owner.list' && items
            ? { ok: true, result: { items, counts: {}, seenEventId: 'e0' } }
            : request.method === 'bots.chatTree'
              ? { ok: true, result: { chats, workspaceChats: {} } }
              : // A host without search, so the list searches the chats read here.
                request.method === 'bots.chats.search'
                ? { ok: false, error: { code: METHOD_NOT_FOUND, message: METHOD_NOT_FOUND } }
                : fallback(request)
    })
    withBotConnectorRuntime(window.api)
  }
}

/** A chat in a bot's chat tree: a side chat, idle, 20 minutes ago, unless `rest` says otherwise. */
export function fixtureChat(
  chatId: string,
  title: string,
  rest: Partial<BotChatTreeChat> = {}
): BotChatTreeChat {
  const running = rest.running ?? []
  const finished = rest.finished ?? []
  return {
    chatId,
    title,
    origin: 'side',
    live: 'idle',
    lastActiveAt: now - 20 * 60_000,
    unread: false,
    closed: false,
    runningTotal: running.length,
    finishedTotal: finished.length,
    failedTotal: finished.filter((worker) => worker.state === 'failed').length,
    ...rest,
    running,
    finished
  }
}

/** A worker the bot's chat started, 4 minutes ago. */
export const fixtureWorker = (id: string, title: string, dot: AgentDotState): BotWorkerRow => ({
  kind: 'worker',
  key: `worker:${id}`,
  dispatchId: id,
  title,
  dot,
  origin: { kind: 'chat' },
  paneKey: null,
  workspaceId: null,
  at: now - 4 * 60_000,
  worker: null
})

/** One of the bot's automations, on, next running in 18 hours unless `overrides` says otherwise. */
export const fixtureAutomation = (
  id: string,
  name: string,
  rrule: string,
  overrides: Partial<BotAutomationRow['automation']> = {}
): BotAutomationRow => ({
  key: id,
  failing: false,
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows read only these fields.
  automation: {
    id,
    name,
    enabled: true,
    nextRunAt: now + 18 * 3_600_000,
    updatedAt: 1,
    dtstart: now - 86_400_000,
    rrule,
    workspaceId: home,
    ...overrides
  } as BotAutomationRow['automation']
})

export const fixtureSuggestion = (
  id: string,
  title: string,
  why: string,
  link: string
): Suggestion => ({
  id,
  title,
  why,
  ask: title,
  link,
  source: suggestionSource(link),
  createdAt: 1
})

const CHAT_PANE_KEY = structuredAgentSessionStatusPaneKey('chat-cos')

function chatStatus(state: AgentStatusState): AgentStatusEntry {
  return {
    state,
    prompt: '',
    updatedAt: now,
    stateStartedAt: now,
    paneKey: CHAT_PANE_KEY,
    terminalTitle: '',
    stateHistory: [],
    agentType: 'claude'
  }
}

export function botPanelPage(open: boolean, chatState: AgentStatusState | null): Partial<AppState> {
  return {
    activeWorktreeId: home,
    activeWorkspaceKey: home,
    rightSidebarOpen: open,
    rightSidebarWidth: 340,
    rightSidebarTab: 'bot-activity',
    // Its home, so the header's status line has a workspace to read.
    folderWorkspaces: [
      makeFolderWorkspace({
        id: fixtureCos.folderWorkspaceId,
        projectGroupId: 'bots',
        name: fixtureCos.name,
        folderPath: `/home/me/.orca/bots/${fixtureCos.folder}`
      })
    ],
    agentStatusByPaneKey: acceptedAgentStatuses(
      chatState ? [[CHAT_PANE_KEY, chatStatus(chatState)]] : []
    )
  }
}

// The sidebar's own shell pulls in node-only panels, so this frames its real tabs and Activity body.
export function BotPanelFrame(): React.JSX.Element {
  const { visibleItems } = useRightSidebarActivityItems({ rightSidebarOpen: true })
  const tab = useAppStore((s) => s.rightSidebarTab)
  const [stripWidth, setStripWidth] = useState<number | null>(null)
  const stripRef = useMeasuredWidth(setStripWidth)
  const { compactIds } = getTopActivityBarLayout(visibleItems, stripWidth, tab, 0, measureTabTitle)
  return (
    <div className="flex min-h-[720px] flex-col border-l border-border bg-sidebar">
      <div className="flex h-[36px] min-h-[36px] items-center border-b border-border">
        <div ref={stripRef} className="flex min-w-0 flex-1 gap-0.5">
          {visibleItems.map((item) => (
            <ActivityBarButton
              key={item.id}
              item={item}
              active={item.id === tab}
              onClick={() => {}}
              layout="top"
              compact={compactIds.has(item.id)}
            />
          ))}
        </div>
        <span className="sidebar-toggle mr-1">
          <PanelRight size={16} />
        </span>
      </div>
      {tab === 'bot-chats' ? <BotChatsPanel /> : <BotActivityPanel />}
    </div>
  )
}
