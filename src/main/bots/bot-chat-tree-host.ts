// `bots.chatTree`: a bot's chats with the workers each started, built on the bot's host from its own records.
import { structuredAgentSessionStatusPaneKey } from '../../shared/agent-session/view/structured-agent-session-tab'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentListVerdict } from '../../shared/agent-status/presentation/agent-list-status'
import { handedAgentRows } from '../../shared/bots/bot-activity-handed-agents'
import type { BotChatTreeRead, BotChatTreeWorker } from '../../shared/bots/bot-chat-tree'
import {
  botChatTreeDispatchIds,
  buildBotChatTree,
  placeBotChatDispatches,
  type BotChatTreeExtra
} from '../../shared/bots/bot-chat-tree-model'
import type { OrchestrationSessionWorker } from '../../shared/orchestration-session-workers'
import {
  readAgentSessionRecordStore,
  type AgentSessionRecordReader
} from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { readDispatchWorkers } from '../runtime/rpc/methods/orchestration/worker/session-workers-method'
import type { BotBackgroundRuns } from './bot-background-run-records'
import { buildBotChatBase, orderedBaseChats, readBotChatInputs } from './bot-chat-tree-base'
import { createBotChatTreeIndex, type BotChatTreeIndex } from './bot-chat-tree-index'
import { overlayBotChats } from './bot-chat-tree-overlay'
import type { BotChatTreeWorkerCache } from './bot-chat-tree-worker-cache'
import { createSharedBotBuilds } from './shared-bot-builds'
import {
  botStatusRowsByPaneKey,
  readBotHandedAgents,
  runtimeBotActivityHost,
  type BotActivityHost
} from './bot-activity-host'
import type { BotChatTreeParams } from '../../shared/rpc-contract/bots-params'
import type { Bot } from '../../shared/bot-types'

export type BotChatTreeHost = BotActivityHost & {
  /** The chat records, which live in the chat host that opens lazily. */
  sessionRecords: () => Promise<AgentSessionRecordReader | null>
  db: () => OrchestrationDb
  dispatchWorkers: (dispatchIds: readonly string[]) => Promise<OrchestrationSessionWorker[]>
  backgroundRuns: BotBackgroundRuns
  /** The desktop window's Agents-list verdicts by pane, read state included; none on a host without a window. */
  agentListVerdicts?: () => Readonly<Record<string, AgentListVerdict>> | undefined
  /** Keeps each bot's base between reads; without it, every read scans every record on the host. */
  index?: Pick<BotChatTreeIndex, 'base'>
  /** Keeps settled workers between reads; without it, every read re-reads every shown worker. */
  workerCache?: BotChatTreeWorkerCache
}

function handedWorker(row: ReturnType<typeof handedAgentRows>[number]): BotChatTreeWorker {
  return {
    key: row.key,
    title: row.title,
    state:
      row.dot === 'permission' || row.dot === 'blocked' || row.dot === 'waiting'
        ? 'needs-you'
        : 'running',
    startedAt: row.at,
    ...(row.workspaceId ? { worktreeId: row.workspaceId } : {}),
    ...(row.paneKey ? { paneKey: row.paneKey } : {}),
    note: 'handed-over',
    ...(row.hostId ? { hostId: row.hostId } : {})
  }
}

/** The status row a worker's agent and host are read from, as a key that changes when that row does. */
function workerStatusEvidence(
  host: BotChatTreeHost
): (worker: OrchestrationSessionWorker) => string {
  const byPane = new Map<string, AgentStatusIpcPayload>()
  const byHandle = new Map<string, AgentStatusIpcPayload>()
  for (const row of host.statusRows()) {
    byPane.set(row.paneKey, row)
    if (row.terminalHandle) {
      byHandle.set(row.terminalHandle, row)
    }
  }
  const key = (row: AgentStatusIpcPayload | undefined): string =>
    row ? `${row.agentType ?? ''}|${row.connectionId ?? ''}` : ''
  // A worker's row is matched by its pane, else by its terminal handle.
  return (worker) =>
    `${key(worker.paneKey ? byPane.get(worker.paneKey) : undefined)}/${key(
      worker.address ? byHandle.get(worker.address) : undefined
    )}`
}

async function readBotChatBase(host: BotChatTreeHost, bot: Bot) {
  const store = await host.sessionRecords()
  const inputs = readBotChatInputs(host, bot)
  // The index keeps the base between reads; without one, a read builds it from every record.
  const build = host.index
    ? host.index.base(bot, inputs)
    : buildBotChatBase(
        { db: host.db(), backgroundRuns: host.backgroundRuns },
        store,
        inputs,
        store?.listRecords() ?? []
      )
  return { store, inputs, build }
}

/** The bot's newest empty side chat on its agent whose tab is open, so New chat opens it again. */
export async function openEmptyBotChat(host: BotChatTreeHost, bot: Bot): Promise<string | null> {
  const { store, inputs, build } = await readBotChatBase(host, bot)
  const tabbed = new Set((await host.chatTabs(inputs.workspaceId)).map((tab) => tab.sessionId))
  const chat = orderedBaseChats(build.chats.values()).find(
    (entry) =>
      entry.empty &&
      tabbed.has(entry.chatId) &&
      store?.getRecord(entry.chatId)?.provider === bot.agent
  )
  return chat?.chatId ?? null
}

export async function readBotChatTree(
  host: BotChatTreeHost,
  params: BotChatTreeParams
): Promise<BotChatTreeRead> {
  return (await readBotChatTreeParts(host, params)).tree
}

/** The tree with what it was built from: every Dispatch placed under its chat, and each session's chat. */
export type BotChatTreeParts = {
  tree: BotChatTreeRead
  placed: ReturnType<typeof placeBotChatDispatches>
  rootOf: (sessionId: string) => string
}

export async function readBotChatTreeParts(
  host: BotChatTreeHost,
  params: BotChatTreeParams
): Promise<BotChatTreeParts> {
  const bots = host.bots()
  host.workerCache?.keepBots(bots.map((entry) => entry.id))
  const bot = bots.find((entry) => entry.id === params.botId)
  if (!bot) {
    throw new Error('bot_not_found')
  }
  const { inputs, build } = await readBotChatBase(host, bot)
  const { rootOf } = build
  const rowByPaneKey = botStatusRowsByPaneKey(host)
  const tabs = await host.chatTabs(inputs.workspaceId).catch(() => [])
  // A thread the bot started on its own is new until first opened anywhere (opening marks its link);
  // the same rule as the bot row's count, so the count and what its click opens agree.
  const chats = overlayBotChats(orderedBaseChats(build.chats.values()), inputs, {
    rowByPaneKey,
    readVerdicts: host.agentListVerdicts?.(),
    tabTitles: new Map(
      tabs.flatMap((tab) => (tab.title ? [[rootOf(tab.sessionId), tab.title] as const] : []))
    ),
    tabbed: new Set(tabs.map((tab) => rootOf(tab.sessionId))),
    unseen: new Set(
      inputs.links.flatMap((link) =>
        link.bot?.kind === 'bot' && link.seenAt === null ? [rootOf(link.sessionId)] : []
      )
    )
  })
  const placed = placeBotChatDispatches(chats, build.placement.dispatches())
  const page =
    params.chatId !== undefined
      ? {
          chatId: params.chatId,
          ...(params.finishedAfter ? { after: params.finishedAfter } : {})
        }
      : undefined
  // Handed-over agents, under Home.
  const extras: BotChatTreeExtra[] = []
  // Unreadable worker records must not hide the chats.
  const dispatchIds = botChatTreeDispatchIds(chats, placed, extras, page)
  const workers: OrchestrationSessionWorker[] = await (
    host.workerCache
      ? host.workerCache.read(
          {
            botId: bot.id,
            dispatchIds,
            settled: new Set(
              placed.flatMap((entry) => (entry.dispatch.settled ? [entry.dispatch.id] : []))
            ),
            evidenceOf: workerStatusEvidence(host),
            source: host.db()
          },
          host.dispatchWorkers
        )
      : host.dispatchWorkers(dispatchIds)
  ).catch((error: unknown) => {
    console.error('[bots] failed to read workers for the chats tree:', error)
    return []
  })

  // A page read is one chat's finished workers: handed-over agents only ever run, under Home.
  const handedWorkspaces = page
    ? new Set<string>()
    : await (host.handedWorktreeIds?.(bot) ?? Promise.resolve(new Set<string>())).catch(
        () => new Set<string>()
      )
  if (!page) {
    // The bot's own workers by every pane they show under: a chat worker's record names none, so its
    // session's status pane counts too, read or not.
    const own = build.placement.creatorKeys()
    const placedPanes = new Set([
      ...workers.flatMap((worker) => (worker.paneKey ? [worker.paneKey] : [])),
      ...own.panes,
      ...own.sessions.map(structuredAgentSessionStatusPaneKey)
    ])
    const handedAgents = await readBotHandedAgents(host, bot, rowByPaneKey, handedWorkspaces)
    extras.push(
      ...handedAgentRows(handedAgents.filter((agent) => !placedPanes.has(agent.paneKey))).map(
        (row) => ({ worker: handedWorker(row), settled: false, at: row.at })
      )
    )
  }
  const tree = buildBotChatTree({
    chats,
    placed,
    workers: new Map(
      workers.map((worker): [string, OrchestrationSessionWorker] => [worker.dispatchId, worker])
    ),
    extras,
    homeWorkspaceIds: [...handedWorkspaces],
    page
  })
  return { tree, placed, rootOf }
}

const sharedTreeBuilds = createSharedBotBuilds<BotChatTreeRead>()

/** A full read is shared by every caller asking at once; a page read is one caller's own. */
export function readSharedBotChatTree(
  runtime: OrcaRuntimeService,
  params: BotChatTreeParams
): Promise<BotChatTreeRead> {
  const host = runtimeBotChatTreeHost(runtime)
  return params.chatId === undefined
    ? sharedTreeBuilds(runtime, params.botId, () => readBotChatTree(host, params))
    : readBotChatTree(host, params)
}

export function runtimeBotChatTreeHost(runtime: OrcaRuntimeService): BotChatTreeHost {
  return {
    ...runtimeBotActivityHost(runtime),
    sessionRecords: async () => {
      await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
      return readAgentSessionRecordStore()
    },
    db: () => runtime.getOrchestrationDb(),
    dispatchWorkers: (dispatchIds) =>
      readDispatchWorkers(runtime, dispatchIds, { lostTerminalsEnded: true }),
    backgroundRuns: runtime.lookAround,
    agentListVerdicts: () => runtime.readAgentListPublication()?.verdicts,
    ...(runtime.botChatTreeIndex ? { index: runtime.botChatTreeIndex } : {}),
    workerCache: runtime.botChatTreeWorkers
  }
}

/** The runtime's one chat-tree index: fed by the record store's commits and the database's Dispatch
 *  changes, it tells the runtime's notices which bots each change concerns. */
export function runtimeBotChatTreeIndex(runtime: OrcaRuntimeService): BotChatTreeIndex {
  const activity = runtimeBotActivityHost(runtime)
  return createBotChatTreeIndex({
    bots: () => runtime.bots.list(),
    records: readAgentSessionRecordStore,
    db: () => runtime.getOrchestrationDb(),
    backgroundRuns: runtime.lookAround,
    inputs: (bot) => readBotChatInputs(activity, bot),
    changed: (scope) => runtime.notifyBotsChanged(scope),
    // Full checks wait for a host with nothing working.
    idle: () => !(runtime.getAgentStatusSnapshotFn?.() ?? []).some((row) => row.state === 'working')
  })
}
