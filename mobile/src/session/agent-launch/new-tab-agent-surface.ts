import {
  nativeChatPreferenceFor,
  type NativeChatDefaultSettings
} from '../../../../src/shared/agent-launch/choices/structured-native-chat-launch-route'
import type { TuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent'
import type { AgentLaunchSurface } from '../../../../src/shared/agent-launch/contracts/agent-launch-surface'

export type NewTabAgentSurfaces = {
  /** The switch's segment; none when the host's own choice differs between the listed agents. */
  selected: AgentLaunchSurface | undefined
  /** False once the host's agents list lacks the agent. */
  canChat: (agent: TuiAgent) => boolean
  /** Sent as agent.launch's nativeChatDefault, a preference, so a chat that can't open here starts
   *  the CLI. Undefined leaves an unpicked launch to the host that owns that default. */
  nativeChatDefaultFor: (agent: TuiAgent) => boolean | undefined
}

/**
 * The phone's own pick wins; until there is one, each agent starts as its host would start it, and a
 * headless host with no choice of its own (null) starts chats. `chatAgents` is undefined until the
 * host lists them. Older hosts publish no choice and keep deciding each launch themselves.
 */
export function resolveNewTabAgentSurfaces(args: {
  agents: readonly TuiAgent[]
  chatAgents: ReadonlySet<string> | undefined
  picked: AgentLaunchSurface | null
  hostDefaults: NativeChatDefaultSettings | null | undefined
}): NewTabAgentSurfaces | null {
  const { chatAgents, picked, hostDefaults } = args
  if (hostDefaults === undefined) {
    return null
  }
  const canChat = (agent: TuiAgent) => chatAgents?.has(agent) ?? true
  const listed = args.agents.filter(canChat)
  if (listed.length === 0) {
    return null
  }
  const startsAsChat = (agent: TuiAgent): boolean =>
    canChat(agent) &&
    (picked !== null ? picked === 'chat' : hostStartsAgentAsChat(hostDefaults, agent))
  const surfaces = new Set(listed.map((agent) => (startsAsChat(agent) ? 'chat' : 'terminal')))
  const [only] = surfaces
  return {
    selected: surfaces.size === 1 ? only : undefined,
    canChat,
    nativeChatDefaultFor: (agent) =>
      picked !== null || hostDefaults === null ? startsAsChat(agent) : undefined
  }
}

/** A headless host with no choice of its own (null) starts chats; an older host's absence starts none. */
export function hostStartsAgentAsChat(
  hostDefaults: NativeChatDefaultSettings | null | undefined,
  agent: TuiAgent
): boolean {
  return hostDefaults === null || nativeChatPreferenceFor(hostDefaults, agent)
}
