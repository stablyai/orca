import {
  nativeChatPreferenceFor,
  type NativeChatDefaultSettings
} from '../../../../src/shared/agent-launch/choices/structured-native-chat-launch-route'
import type { TuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent'
import type { AgentLaunchSurface } from '../../../../src/shared/agent-launch/contracts/agent-launch-surface'

export type NewTabAgentSurfaces = {
  canChoose: boolean
  /** The switch's segment; none when the host's own choice differs between the listed agents. */
  selected: AgentLaunchSurface | undefined
  /** False once the host's agents list lacks the agent. */
  canChat: (agent: TuiAgent) => boolean
  surfaceFor: (agent: TuiAgent) => AgentLaunchSurface | undefined
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
  structuredHost: boolean | undefined
  agents: readonly TuiAgent[]
  chatAgents: ReadonlySet<string> | undefined
  picked: AgentLaunchSurface | null
  hostDefaults: NativeChatDefaultSettings | null | undefined
}): NewTabAgentSurfaces {
  const { structuredHost, chatAgents, picked, hostDefaults } = args
  const canUseDefaults = structuredHost === true && hostDefaults !== undefined
  const canChat = (agent: TuiAgent) => structuredHost !== false && (chatAgents?.has(agent) ?? true)
  const listed = args.agents.filter(canChat)
  const canChoose = canUseDefaults && listed.length > 0
  const surfaceFor = (agent: TuiAgent): AgentLaunchSurface | undefined => {
    if (!canChat(agent)) {
      return 'terminal'
    }
    if (!canUseDefaults) {
      return undefined
    }
    const chat = picked !== null ? picked === 'chat' : hostStartsAgentAsChat(hostDefaults, agent)
    return chat ? 'chat' : 'terminal'
  }
  const surfaces = new Set(listed.map(surfaceFor))
  const [only] = surfaces
  return {
    canChoose,
    selected: surfaces.size === 1 ? only : undefined,
    canChat,
    surfaceFor,
    nativeChatDefaultFor: (agent) =>
      canChoose && (picked !== null || hostDefaults === null)
        ? surfaceFor(agent) === 'chat'
        : undefined
  }
}

/** A headless host with no choice of its own (null) starts chats; an older host's absence starts none. */
export function hostStartsAgentAsChat(
  hostDefaults: NativeChatDefaultSettings | null | undefined,
  agent: TuiAgent
): boolean {
  return hostDefaults === null || nativeChatPreferenceFor(hostDefaults, agent)
}
