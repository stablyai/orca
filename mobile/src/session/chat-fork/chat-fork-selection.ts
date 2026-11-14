import type { TuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent'
import type { ChatForkRecapScope } from '../../../../src/shared/agent-session/context/chat-fork-recap'
import {
  chatForkPath,
  chatForkSurfaceChoice,
  type ChatForkPath,
  type ChatForkSurface
} from '../../../../src/shared/native-chat/chat-fork-path'

/** Where the fork opens: beside this chat, a new sibling worktree, or a workspace already there. */
export type ChatForkWorkspace =
  | { kind: 'this' }
  | { kind: 'new' }
  | { kind: 'existing'; hostId: string; worktreeId: string; name: string }

export type ChatForkRunAs = 'open' | 'subagent'

/** A menu's own shortcut into the sheet: its fields start where that menu item pointed. */
export type ChatForkPreset = 'worktree' | 'subagent' | null

export type ChatForkHostStatus = 'ready' | 'checking' | 'offline' | 'needs-update'

export type ChatForkHost = {
  hostId: string
  status: ChatForkHostStatus
  /** Takes a copied transcript (aiVault import). */
  canImport: boolean
  /** Starts a chat with a first message, which carries a recap. */
  canFirstMessage: boolean
  /** Starts an agent's CLI in a terminal with a first prompt (agent.launch with a surface). */
  canLaunchTerminal: boolean
}

export type ChatForkSource = {
  hostId: string
  agent: TuiAgent
  /** The chat's own kind: a chat session, or a terminal running the agent's CLI. */
  surface: ChatForkSurface
  /** The agent has hit its usage limit: another agent is the useful default. */
  usageLimited: boolean
  /** The chat's history can be copied for the same agent (a terminal chat only for Claude). */
  canCopy: boolean
  /** This host can export the chat's transcript for another host. */
  canExport: boolean
  canNewWorktree: boolean
  canSubagent: boolean
}

/** Only what the person changed; everything else follows the defaults as data arrives. */
export type ChatForkPicks = {
  hostId?: string
  workspace?: ChatForkWorkspace
  agent?: TuiAgent
  runAs?: ChatForkRunAs
  openAs?: ChatForkSurface
  recapScope?: ChatForkRecapScope
}

export type ChatForkSelection = {
  hostId: string
  sameHost: boolean
  /** Null until a workspace is chosen on another host. */
  workspace: ChatForkWorkspace | null
  /** Null when no agent on the chosen host can take this fork. */
  agent: TuiAgent | null
  runAs: ChatForkRunAs
  /** Null when the agent can open as neither kind on the chosen host. */
  openAs: ChatForkSurface | null
  surfaces: Readonly<Record<ChatForkSurface, boolean>>
  path: ChatForkPath
  recapScope: ChatForkRecapScope
  /** Set when the same agent gets a recap because no exact copy reaches this host or kind. */
  sameAgentRecap: boolean
  agentChoices: readonly { agent: TuiAgent; enabled: boolean }[]
  newWorktreeOffered: boolean
  subagentOffered: boolean
  ready: boolean
}

/** The sheet's fields: the person's picks where still valid, defaults everywhere else. */
export function resolveChatForkSelection(input: {
  source: ChatForkSource
  preset: ChatForkPreset
  hosts: readonly ChatForkHost[]
  /** The chosen host's agents; null while unread. */
  targetAgents: readonly TuiAgent[] | null
  picks: ChatForkPicks
}): ChatForkSelection {
  const { source, preset, picks } = input
  // A picked host that drops offline stays picked, unready: never a silent fork elsewhere.
  const hostId = picks.hostId ?? source.hostId
  const sameHost = hostId === source.hostId
  const target = input.hosts.find((host) => host.hostId === hostId)
  const hostReady = sameHost || target?.status === 'ready'
  const relaysTo = source.canExport && target?.canImport === true
  // A recap reaches any connected host that starts a chat or a CLI with a first message.
  const recapAllowed = target?.canFirstMessage === true || target?.canLaunchTerminal === true
  // Another host starts only the agents it lists, this chat's own included.
  const listedThere = sameHost || input.targetAgents?.includes(source.agent) === true
  const sameAgentAllowed =
    (sameHost && source.canCopy) || ((relaysTo || recapAllowed) && listedThere)
  const others = (input.targetAgents ?? []).filter((agent) => agent !== source.agent)
  const agentChoices = [
    { agent: source.agent, enabled: sameAgentAllowed },
    ...others.map((agent) => ({ agent, enabled: recapAllowed }))
  ]
  const enabled = (agent: TuiAgent | undefined): agent is TuiAgent =>
    agentChoices.some((choice) => choice.agent === agent && choice.enabled)
  const firstOther = others.find(enabled) ?? null
  const agent = enabled(picks.agent)
    ? picks.agent
    : source.usageLimited && firstOther
      ? firstOther
      : sameAgentAllowed
        ? source.agent
        : firstOther
  const sameAgent = agent === source.agent
  const relays = sameAgent && relaysTo
  const surfaces = chatForkSurfaces({
    source,
    own: sameHost && sameAgent && source.canCopy,
    relays,
    target,
    chatAgent: agent !== null && (input.targetAgents === null || input.targetAgents.includes(agent))
  })
  const openAs = chatForkSurfaceChoice({
    sourceSurface: source.surface,
    picked: picks.openAs,
    available: surfaces
  })
  const path = chatForkPath({
    sameAgent,
    sameHost,
    sameSurface: openAs === source.surface,
    cutsHere: source.canCopy,
    relays
  })
  const subagentOffered = path === 'same' && sameHost && source.canSubagent && source.canNewWorktree
  const runAs: ChatForkRunAs =
    subagentOffered && (picks.runAs ?? (preset === 'subagent' ? 'subagent' : 'open')) === 'subagent'
      ? 'subagent'
      : 'open'
  const newWorktreeOffered = sameHost && source.canNewWorktree
  const workspace = resolveWorkspace({ picks, preset, hostId, sameHost, newWorktreeOffered, runAs })
  return {
    hostId,
    sameHost,
    workspace,
    agent,
    runAs,
    openAs,
    surfaces,
    path,
    recapScope: picks.recapScope ?? 'history',
    sameAgentRecap: sameAgent && path === 'recap',
    agentChoices,
    newWorktreeOffered,
    subagentOffered,
    ready: hostReady && agent !== null && workspace !== null && openAs !== null
  }
}

/** The kinds a fork can open as: the chat's own kind for its exact copy here; either kind for a
 *  copy relayed from this host (Claude resumes it as a chat or in its CLI); a chat where the host
 *  starts that agent's chat with a first message; a terminal where it launches CLIs with a prompt. */
function chatForkSurfaces(input: {
  source: ChatForkSource
  own: boolean
  relays: boolean
  target: ChatForkHost | undefined
  chatAgent: boolean
}): Record<ChatForkSurface, boolean> {
  const { source, own, relays, target } = input
  return {
    chat:
      (own && source.surface === 'chat') ||
      relays ||
      (target?.canFirstMessage === true && input.chatAgent),
    terminal: (own && source.surface === 'terminal') || relays || target?.canLaunchTerminal === true
  }
}

function resolveWorkspace(input: {
  picks: ChatForkPicks
  preset: ChatForkPreset
  hostId: string
  sameHost: boolean
  newWorktreeOffered: boolean
  runAs: ChatForkRunAs
}): ChatForkWorkspace | null {
  // A background subagent always works in a worktree of its own.
  if (input.runAs === 'subagent') {
    return { kind: 'new' }
  }
  const pick = input.picks.workspace
  if (pick) {
    const valid =
      pick.kind === 'existing'
        ? pick.hostId === input.hostId
        : pick.kind === 'new'
          ? input.newWorktreeOffered
          : input.sameHost
    if (valid) {
      return pick
    }
  }
  if (!input.sameHost) {
    return null
  }
  return input.preset !== null && input.newWorktreeOffered ? { kind: 'new' } : { kind: 'this' }
}
