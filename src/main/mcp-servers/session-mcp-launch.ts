// Which MCP servers a new chat session gets from Orca, decided on the host that runs it: a bot's own
// tools in its home folder, and the host's list for every session (a bot only when it opts in),
// filtered by the session's agent and workspace. With the host's switch off, only a bot's own.
import { mcpServerWorkspaceKeyOf } from '../../shared/mcp-servers/mcp-servers'
import type { Bot } from '../../shared/bot-types'
import { currentBotToolsRevision, readBotLaunchServers } from '../bots/bot-tools-file'
import {
  advanceBotToolsEpoch,
  botToolsEpoch,
  type BotLaunchedTools
} from '../bots/bot-tools-revision'
import { onMcpHostListSignInChanged } from './mcp-host-list-sign-in'
import { botToolRelay, type BotToolRelay } from '../bots/tool-relay/bot-tool-relay'
import { mcpServersWithDigestsForLaunch } from './mcp-host-list-launch'
import { mcpHostListFolder } from './mcp-host-list-folder'
import { botHostMcpAccess } from './bot-host-mcp-access'
import { isMcpServersFeatureEnabled } from './mcp-servers-feature'
import { SessionMcpTools, type SessionHostMcpServers } from './session-mcp-tools'

// An Orca sign-in to a host-list server is a list change its chats compare: only one whose server
// it is restarts (its digest names the grant, never a token refresh or a lost sign-in).
onMcpHostListSignInChanged(() => advanceBotToolsEpoch(mcpHostListFolder()))

type LaunchRecord = { provider: string; location: { workspaceId: string } }
type HostWorkspace = { key: string | null } | 'any'

/** What a launch read of the host list: the server set this session resolved, and how to read it again. */
export type HostLaunchedTools = {
  folder: string
  agent: string
  workspace: HostWorkspace
  /** Each resolved server's digest, by name (`mcpServersForLaunch`). */
  digests: Readonly<Record<string, string>>
  /** The list's epoch read before it: Orca's own writes and sign-ins since then advance it. */
  epoch: number
}

/** What a session launched with: its bot's own tools, and the host list's servers it got. */
export type SessionLaunchedTools = { bot: BotLaunchedTools | null; host: HostLaunchedTools | null }

type HostRead = { host: SessionHostMcpServers; launched: HostLaunchedTools }

/** The host list's servers for this launch, maybe none; undefined with the switch off, or when the
 *  list can't be read. */
async function hostServersFor(
  agent: string,
  workspace: HostWorkspace,
  given: string | undefined
): Promise<HostRead | undefined> {
  if (!isMcpServersFeatureEnabled()) {
    return undefined
  }
  const folder = given ?? mcpHostListFolder()
  // Read before the list: a write in between makes this launch look stale, never current.
  const epoch = botToolsEpoch(folder)
  try {
    const { servers, sharedProcesses, digests } = await mcpServersWithDigestsForLaunch(
      agent,
      workspace,
      folder
    )
    return {
      host: { folder, servers, sharedProcesses },
      launched: { folder, agent, workspace, digests, epoch }
    }
  } catch (error) {
    // A broken list never stops a chat starting; its settings page shows the file's problem.
    console.warn(
      '[mcp-servers] the host list could not be read; this session starts without it',
      error
    )
    return undefined
  }
}

/**
 * The session's servers. `bot` is the bot whose home the session runs in, or null. `launched` is
 * what the session's next turns compare against to pick up a change to the servers it got; null
 * when it got none from Orca (a chat with the switch off, or no server on for it).
 */
export async function sessionMcpLaunchTools(
  bot: Pick<Bot, 'id' | 'hostMcpServers'> | null,
  record: LaunchRecord,
  launchDirectory: string,
  deps: { relay?: Pick<BotToolRelay, 'grant'>; hostFolder?: string } = {}
): Promise<{ tools: SessionMcpTools; launched: SessionLaunchedTools | null }> {
  const relay = deps.relay ?? botToolRelay
  if (bot) {
    const own = await readBotLaunchServers(launchDirectory)
    // A bot's home isn't one of the user's workspaces: it takes every server on for its agent.
    const read = bot.hostMcpServers
      ? await hostServersFor(record.provider, 'any', deps.hostFolder)
      : undefined
    // A list it can't read keeps the token's reach, so the bot's running chats keep theirs.
    const host = read?.host ?? botHostMcpAccess(bot.hostMcpServers === true, deps.hostFolder)
    const tools = await SessionMcpTools.for(
      relay,
      { bot: { botId: bot.id, folder: launchDirectory }, agent: record.provider },
      { own: own.servers, ...(host ? { host } : {}) }
    )
    return { tools, launched: { bot: own.launched, host: read?.launched ?? null } }
  }
  const key = mcpServerWorkspaceKeyOf(record.location.workspaceId)
  const read = await hostServersFor(record.provider, { key }, deps.hostFolder)
  if (!read) {
    return { tools: SessionMcpTools.none, launched: null }
  }
  // Recorded even with no server on, so turning one on reaches the session's next turn.
  const tools =
    read.host.servers.length > 0
      ? await SessionMcpTools.for(relay, { bot: null, agent: record.provider }, { host: read.host })
      : SessionMcpTools.none
  return { tools, launched: { bot: null, host: read.launched } }
}

/**
 * No I/O: whether Orca itself wrote or signed in to the bot's tools or the host list since launch.
 * A host-list write may not touch this session's servers; `sessionLaunchToolsChanged` decides.
 */
export function sessionLaunchToolsOutdated(launched: SessionLaunchedTools): boolean {
  return (
    (launched.bot !== null && botToolsEpoch(launched.bot.folder) !== launched.bot.epoch) ||
    (launched.host !== null && botToolsEpoch(launched.host.folder) !== launched.host.epoch)
  )
}

/**
 * Whether the bot's tools changed (reread, so edits made outside Orca count too), or a host-list
 * server this session got, or would get now, did. `delivered` is what the session's agent took of
 * the list at launch: a server it left out (its own of the name won) or an agent that takes none
 * makes an edit not this session's. The list is Orca's own file, so it's reread only after Orca
 * wrote or signed in to it; an edit that isn't this session's moves the recorded epoch on instead.
 */
export async function sessionLaunchToolsChanged(
  launched: SessionLaunchedTools,
  delivered: ReadonlySet<string> | 'ignored' | undefined
): Promise<boolean> {
  if (
    launched.bot &&
    (await currentBotToolsRevision(launched.bot.folder)) !== launched.bot.revision
  ) {
    return true
  }
  const host = launched.host
  if (!host) {
    return false
  }
  const epoch = botToolsEpoch(host.folder)
  if (epoch === host.epoch || delivered === 'ignored') {
    host.epoch = epoch
    return false
  }
  const now = await hostServersFor(host.agent, host.workspace, host.folder)
  if (!now && isMcpServersFeatureEnabled()) {
    // The list can't be read now: the next turn compares again, so a change isn't lost.
    return false
  }
  // Not knowing what it got, count every server it launched with as its own.
  const got = delivered ?? new Set(Object.keys(host.digests))
  if (now && touchesSession(host.digests, now.launched.digests, got)) {
    return true
  }
  // Not this session's, or the switch went off: nothing to act on.
  host.epoch = epoch
  return false
}

/** A new server whose name the agent's own config already has restarts once; reading the agent's
 *  config every turn to spare it would cost more. */
function touchesSession(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
  delivered: ReadonlySet<string>
): boolean {
  const leftOut = (name: string) => Object.hasOwn(before, name) && !delivered.has(name)
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].some(
    (name) => !leftOut(name) && before[name] !== after[name]
  )
}
