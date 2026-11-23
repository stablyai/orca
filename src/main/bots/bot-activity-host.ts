// A bot's Activity, built on its execution host from the host's own facts, so every client reads the same rows.
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentStatusOrchestrationContext } from '../../shared/agent-status/contracts/agent-status-types'
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { Bot } from '../../shared/bot-types'
import {
  BOT_ACTIVITY_COMPLETED_LIMIT,
  buildBotActivity,
  type BotActivityStatus,
  type BotRecordedWorker,
  type BotWorkerObservation
} from '../../shared/bots/bot-activity-model'
import { worktreesUnderHomes } from './bot-handed-workspaces'
import { readPairedHandedAgents } from './bot-paired-handed-agents'
import type { BotHandedAgentObservation } from '../../shared/bots/bot-activity-handed-agents'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { latestLiveAgentStatusRowsByPaneKey } from '../../shared/agent-status/live-agent-status-rows'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { readDispatchWorkers } from '../runtime/rpc/methods/orchestration/worker/session-workers-method'
import type { BotUpNext } from '../../shared/bots/bot-look-around'
import { lookAroundUpNext } from './bot-look-around-state'
import { lookAroundDueAt, lookAroundNextAt } from './bot-look-around-schedule'
import { botLookAround } from '../../shared/bots/bot-look-around'
import { createSharedBotBuilds } from './shared-bot-builds'
import type { BotActivityRead } from '../../shared/bots/bot-activity-schema'
import { chatPaneKey } from '../../shared/agent-session/view/structured-agent-session-projection'

/** The chats and panes whose Dispatches are the bot's workers. */
export type BotWorkerCreators = { orcaSessionIds: string[]; paneKeys: string[] }

export type BotActivityHost = {
  bots: () => readonly Bot[]
  externalConversations: (folderWorkspaceId: string) => readonly ExternalConversationLink[]
  /** The workspace's chat tabs. */
  chatTabs: (workspaceId: string) => Promise<readonly { sessionId: string; title: string }[]>
  statusRows: () => readonly AgentStatusIpcPayload[]
  /** Each pane's Dispatch, which hook status rows never carry. */
  orchestrationByPaneKey?: () =>
    | Readonly<Record<string, AgentStatusOrchestrationContext>>
    | undefined
  automations: () => readonly Automation[]
  /** Each named automation's runs, newest first; one absent has none. */
  automationRuns: (
    automationIds: readonly string[]
  ) => ReadonlyMap<string, readonly AutomationRun[]>
  /** One read: every unsettled worker these created, plus their newest settled ones. */
  recordedWorkers: (creators: BotWorkerCreators) => Promise<readonly BotRecordedWorker[]>
  /** The ids of the worktrees under the bot's home: their agents work for the bot. */
  handedWorktreeIds?: (bot: Bot) => Promise<ReadonlySet<string>>
  /** The agents in workspaces handed to the bot on paired computers, as those computers report them. */
  pairedHandedAgents?: (bot: Bot) => Promise<readonly BotHandedAgentObservation[]>
  /** The bot's Up next; undefined while Look around is off. */
  upNext?: (bot: Bot) => BotUpNext | undefined
}

export function activityStatus(row: AgentStatusIpcPayload | undefined): BotActivityStatus | null {
  return row
    ? {
        state: row.state,
        ...(row.workingMode ? { workingMode: row.workingMode } : {}),
        prompt: row.prompt,
        stateStartedAt: row.stateStartedAt,
        ...(row.toolName ? { toolName: row.toolName } : {}),
        ...(row.toolInput ? { toolInput: row.toolInput } : {})
      }
    : null
}

/** The automations' runs, each automation's newest first, in the automations' order. */
export function automationRuns(
  host: Pick<BotActivityHost, 'automationRuns'>,
  automations: readonly Automation[]
): AutomationRun[] {
  // Unreadable run history must not hide the rest of Activity.
  try {
    const runsByAutomation = host.automationRuns(automations.map((automation) => automation.id))
    return automations.flatMap((automation) => runsByAutomation.get(automation.id) ?? [])
  } catch (error) {
    console.error('[bots] failed to read automation runs for Activity:', error)
    return []
  }
}

/** The live status rows, each joined to its pane's Dispatch as worktree ps joins it, so a worker
 *  reads as its Dispatch and never by its preamble. Nested workers report under their parent's pane. */
export function botStatusRowsByPaneKey(
  host: Pick<BotActivityHost, 'statusRows' | 'orchestrationByPaneKey'>,
  rows = host.statusRows(),
  workspacesNeedingDispatch?: ReadonlySet<string>
): Map<string, AgentStatusIpcPayload> {
  const latest = latestLiveAgentStatusRowsByPaneKey(rows)
  if (!host.orchestrationByPaneKey || workspacesNeedingDispatch?.size === 0) {
    return latest
  }
  let orchestration: ReturnType<NonNullable<BotActivityHost['orchestrationByPaneKey']>> | null =
    null
  for (const [pane, row] of latest) {
    if (
      workspacesNeedingDispatch &&
      !(row.worktreeId && workspacesNeedingDispatch.has(row.worktreeId))
    ) {
      continue
    }
    if (orchestration === null) {
      orchestration = host.orchestrationByPaneKey()
    }
    const context = orchestration?.[pane]
    if (context) {
      latest.set(pane, { ...row, orchestration: context })
    }
  }
  return latest
}

/** The agents in workspaces handed to the bot, here and on paired computers. */
export async function readBotHandedAgents(
  host: Pick<BotActivityHost, 'handedWorktreeIds' | 'pairedHandedAgents'>,
  bot: Bot,
  rowByPaneKey: ReadonlyMap<string, AgentStatusIpcPayload>,
  /** The workspaces under the bot's home, when the caller has read them already. */
  handedWorktreeIds?: ReadonlySet<string>
): Promise<BotHandedAgentObservation[]> {
  // A workspace handed to the bot keeps its own agents; they work for the bot without a Dispatch.
  const handed =
    handedWorktreeIds ??
    (await (host.handedWorktreeIds?.(bot) ?? Promise.resolve(new Set<string>())).catch(
      (error: unknown) => {
        console.error('[bots] failed to read handed workspaces for Activity:', error)
        return new Set<string>()
      }
    ))
  // With or without another coordinator's Dispatch: the workspace is the bot's now.
  const localHanded: BotHandedAgentObservation[] = [...rowByPaneKey.values()].flatMap((row) =>
    row.worktreeId && handed.has(row.worktreeId)
      ? [
          {
            paneKey: row.paneKey,
            entry: activityStatus(row)!,
            worktreeId: row.worktreeId,
            ...(row.orchestration?.taskTitle ? { taskTitle: row.orchestration.taskTitle } : {})
          }
        ]
      : []
  )
  const pairedHanded = await (host.pairedHandedAgents?.(bot) ?? Promise.resolve([])).catch(
    (error: unknown) => {
      console.error('[bots] failed to read paired handed workspaces for Activity:', error)
      return []
    }
  )
  return [...localHanded, ...pairedHanded]
}

export async function readBotActivity(
  host: BotActivityHost,
  botId: string
): Promise<BotActivityRead> {
  const bot = host.bots().find((entry) => entry.id === botId)
  if (!bot) {
    throw new Error('bot_not_found')
  }
  const workspaceId = folderWorkspaceKey(bot.folderWorkspaceId)
  const links = host.externalConversations(bot.folderWorkspaceId)
  const sessions = (await host.chatTabs(workspaceId)).map((tab) => ({
    paneKey: chatPaneKey(tab.sessionId),
    sessionId: tab.sessionId,
    label: tab.title
  }))
  // Taken before the automations are read, so a wait saved before it is in them unless it ended.
  const readAt = Date.now()
  const automations = host
    .automations()
    .filter((automation) => automation.workspaceId === workspaceId)
  const runs = automationRuns(host, automations)

  const rowByPaneKey = botStatusRowsByPaneKey(host)
  const workers: BotWorkerObservation[] = [...rowByPaneKey.values()].flatMap((row) =>
    row.orchestration
      ? [
          {
            paneKey: row.paneKey,
            orchestration: row.orchestration,
            entry: activityStatus(row),
            worktreeId: row.worktreeId ?? null
          }
        ]
      : []
  )
  const handedAgents = await readBotHandedAgents(host, bot, rowByPaneKey)

  const chatSessionIds = [
    ...sessions.map((session) => session.sessionId),
    ...runs.flatMap((run) => (run.chatSessionId ? [run.chatSessionId] : [])),
    ...links.map((link) => link.sessionId)
  ]
  const creators: BotWorkerCreators = {
    orcaSessionIds: [...new Set(chatSessionIds)],
    paneKeys: [
      ...new Set([
        ...chatSessionIds.map(chatPaneKey),
        ...runs.flatMap((run) => (run.terminalPaneKey ? [run.terminalPaneKey] : []))
      ])
    ]
  }
  // Unreadable worker records must not hide the rest of Activity.
  const recordedWorkers = await host.recordedWorkers(creators).catch((error: unknown) => {
    console.error('[bots] failed to read workers for Activity:', error)
    return []
  })

  const activity = buildBotActivity({
    bot,
    sessions,
    links,
    workers,
    handedAgents,
    recordedWorkers,
    automations,
    runs,
    sessionStatus: (sessionId) => activityStatus(rowByPaneKey.get(chatPaneKey(sessionId)))
  })
  const upNext = host.upNext?.(bot)
  return { ...activity, readAt, ...(upNext ? { upNext } : {}) }
}

export function runtimeBotActivityHost(runtime: OrcaRuntimeService): BotActivityHost {
  return {
    bots: () => runtime.bots.list(),
    externalConversations: (folderWorkspaceId) =>
      runtime.listFolderWorkspaces().find((folder) => folder.id === folderWorkspaceId)
        ?.externalConversations ?? [],
    chatTabs: async (workspaceId) => runtime.listChatSessionTabs(workspaceId),
    statusRows: () => runtime.getAgentStatusSnapshotFn?.() ?? [],
    orchestrationByPaneKey: () => runtime.agentOrchestrationByPaneKey(),
    pairedHandedAgents: (bot) => readPairedHandedAgents(runtime, bot),
    handedWorktreeIds: async (bot) => {
      const home = folderWorkspaceKey(bot.folderWorkspaceId)
      return (
        worktreesUnderHomes(await runtime.listWorkspaceLineage(), [home]).get(home) ?? new Set()
      )
    },
    upNext: (bot) => {
      const now = Date.now()
      const setting = botLookAround(bot)
      const state = runtime.lookAround.get(bot.id)
      const nextAt = lookAroundNextAt(setting, state, now)
      const dueNow = !bot.paused && lookAroundDueAt(setting, state, now, false) !== null
      return lookAroundUpNext(runtime.lookAround, bot, now, nextAt, dueNow)
    },
    automations: () => runtime.listAutomationsForScope().automations,
    automationRuns: (automationIds) => runtime.listAutomationRunsByAutomation(automationIds),
    recordedWorkers: async (creators) => {
      const created = runtime
        .getOrchestrationDb()
        .listDispatchesCreatedByAny(creators, BOT_ACTIVITY_COMPLETED_LIMIT)
      const creatorById = new Map(created.map((dispatch) => [dispatch.id, dispatch]))
      const workers = await readDispatchWorkers(
        runtime,
        created.map((dispatch) => dispatch.id),
        { lostTerminalsEnded: true }
      )
      return workers.flatMap((worker) => {
        const dispatch = creatorById.get(worker.dispatchId)
        return dispatch
          ? [
              {
                worker,
                creatorSessionId: dispatch.creatorOrcaSessionId,
                creatorPaneKey: dispatch.creatorPaneKey
              }
            ]
          : []
      })
    }
  }
}

const sharedActivityBuilds = createSharedBotBuilds<BotActivityRead>()

/** Callers share builds, so more open clients do not multiply the work. */
export function readSharedBotActivity(
  runtime: OrcaRuntimeService,
  botId: string,
  host: BotActivityHost = runtimeBotActivityHost(runtime)
): Promise<BotActivityRead> {
  return sharedActivityBuilds(runtime, botId, () => readBotActivity(host, botId))
}
