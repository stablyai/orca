import {
  nativeChatPreferenceFor,
  type NativeChatDefaultSettings
} from '../../../../src/shared/agent-launch/choices/structured-native-chat-launch-route'
import type { TuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent'
import type { AgentLaunchSurface } from '../../../../src/shared/agent-launch/contracts/agent-launch-surface'

export type NewTabAgentSurfaces = {
  /** The switch's segment; none when the host's own choice differs between the listed agents. */
  selected: AgentLaunchSurface | undefined
  /** What each listed agent starts as; undefined leaves it to the host, as older hosts decide. */
  surfaceFor: (agent: TuiAgent) => AgentLaunchSurface | undefined
}

/** The host's choice for one agent. null is a headless host nobody set one on, which starts on Chat. */
function hostSurface(
  defaults: NativeChatDefaultSettings | null | undefined,
  agent: TuiAgent
): AgentLaunchSurface | undefined {
  if (defaults === undefined) {
    return undefined
  }
  return defaults === null || nativeChatPreferenceFor(defaults, agent) ? 'chat' : 'terminal'
}

/** The phone's own pick wins; until there is one, each agent starts as its host would start it. */
export function resolveNewTabAgentSurfaces(args: {
  agents: readonly TuiAgent[]
  chatAgents: ReadonlySet<string>
  picked: AgentLaunchSurface | null
  hostDefaults: NativeChatDefaultSettings | null | undefined
}): NewTabAgentSurfaces | null {
  const chatAgents = args.agents.filter((agent) => args.chatAgents.has(agent))
  if (chatAgents.length === 0) {
    return null
  }
  const surfaceFor = (agent: TuiAgent): AgentLaunchSurface | undefined =>
    args.chatAgents.has(agent) ? (args.picked ?? hostSurface(args.hostDefaults, agent)) : 'terminal'
  const hostSurfaces = new Set(chatAgents.map((agent) => surfaceFor(agent)))
  const [only] = hostSurfaces
  return { selected: hostSurfaces.size === 1 ? only : undefined, surfaceFor }
}
