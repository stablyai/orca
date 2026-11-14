import type { TuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent'

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
  /** Starts a chat with a first message, which carries another agent's recap. */
  canFirstMessage: boolean
}

export type ChatForkSource = {
  hostId: string
  agent: TuiAgent
  /** The agent has hit its usage limit: another agent is the useful default. */
  usageLimited: boolean
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
}

export type ChatForkSelection = {
  hostId: string
  sameHost: boolean
  /** Null until a workspace is chosen on another host. */
  workspace: ChatForkWorkspace | null
  /** Null when no agent on the chosen host can take this fork. */
  agent: TuiAgent | null
  runAs: ChatForkRunAs
  agentChoices: readonly { agent: TuiAgent; enabled: boolean }[]
  newWorktreeOffered: boolean
  subagentOffered: boolean
  ready: boolean
}

/** How a selection forks: an exact copy here, a copy relayed to another host, or a recap for another agent. */
export type ChatForkRoute = 'copy' | 'relay' | 'recap'

export function chatForkRoute(
  source: Pick<ChatForkSource, 'hostId' | 'agent'>,
  selection: { hostId: string; agent: TuiAgent }
): ChatForkRoute {
  if (selection.agent !== source.agent) {
    return 'recap'
  }
  return selection.hostId === source.hostId ? 'copy' : 'relay'
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
  const picked = input.hosts.find((host) => host.hostId === picks.hostId)
  const hostId = picked?.status === 'ready' ? picked.hostId : source.hostId
  const sameHost = hostId === source.hostId
  const target = input.hosts.find((host) => host.hostId === hostId)
  const sameAgentAllowed = sameHost || (source.canExport && target?.canImport === true)
  const otherAgentAllowed = target?.canFirstMessage === true
  const others = (input.targetAgents ?? []).filter((agent) => agent !== source.agent)
  const agentChoices = [
    { agent: source.agent, enabled: sameAgentAllowed },
    ...others.map((agent) => ({ agent, enabled: otherAgentAllowed }))
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
  const subagentOffered =
    sameHost && agent === source.agent && source.canSubagent && source.canNewWorktree
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
    agentChoices,
    newWorktreeOffered,
    subagentOffered,
    ready: agent !== null && workspace !== null
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
