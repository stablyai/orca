import { AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY } from '../../../src/shared/agent-launch-runtime-capability'
import {
  AGENT_SESSION_AGENTS_METHOD,
  decodeAgentSessionAgentsResult
} from '../../../src/shared/agent-session/agent-session-registered-agents'
import { isNativeChatSupportedAgent } from '../../../src/shared/native-chat-agent-support'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY } from '../../../src/shared/structured-agent-session-surface-capabilities'
import type { RpcClient } from '../transport/rpc-client'
import { loadDefaultSessionView, type MobileSessionView } from '../storage/session-view-preferences'

export type MobileStructuredChatLaunchContext = {
  defaultView: MobileSessionView
  registeredAgents: readonly string[]
  canRequestSurface: boolean
}

let currentContext: MobileStructuredChatLaunchContext | null = null
const listeners = new Set<() => void>()

export function readMobileStructuredChatLaunchContext(): MobileStructuredChatLaunchContext | null {
  return currentContext
}

export function subscribeMobileStructuredChatLaunch(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function publishMobileStructuredChatLaunch(context: MobileStructuredChatLaunchContext): void {
  currentContext = context
  for (const listener of listeners) {
    listener()
  }
}

// Transcript-overlay agents already open as chat on top of a terminal. Other registered agents need an explicit chat launch.
export function mobileStructuredChatLaunchSurface(
  agent: string,
  context: MobileStructuredChatLaunchContext | null
): 'chat' | undefined {
  if (!context?.canRequestSurface || context.defaultView !== 'chat') {
    return undefined
  }
  if (isNativeChatSupportedAgent(agent) || !context.registeredAgents.includes(agent)) {
    return undefined
  }
  return 'chat'
}

export function withMobileStructuredChatLaunch<T extends { agent: string }>(
  options: readonly T[],
  context: MobileStructuredChatLaunchContext | null
): Array<T & { opensAsChat?: true }> {
  return options.map((option) =>
    mobileStructuredChatLaunchSurface(option.agent, context) === 'chat'
      ? { ...option, opensAsChat: true }
      : option
  )
}

async function registeredStructuredAgents(
  client: RpcClient,
  hostCapabilities: readonly string[] | null | undefined
): Promise<readonly string[]> {
  if (
    hostCapabilities != null &&
    !hostCapabilities.includes(STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY)
  ) {
    return []
  }
  try {
    const response = await client.sendRequest(AGENT_SESSION_AGENTS_METHOD, {})
    if (!response.ok) {
      return []
    }
    return (decodeAgentSessionAgentsResult(response.result) ?? []).map((row) => row.agent)
  } catch {
    return []
  }
}

// The phone stores Chat UI locally. Re-read it on each launch so a headless host is not stuck on its terminal default.
export async function loadMobileStructuredChatLaunchContext(args: {
  client: RpcClient
  hostCapabilities: readonly string[] | null | undefined
}): Promise<MobileStructuredChatLaunchContext> {
  const [defaultView, registeredAgents] = await Promise.all([
    loadDefaultSessionView(),
    registeredStructuredAgents(args.client, args.hostCapabilities)
  ])
  const context: MobileStructuredChatLaunchContext = {
    defaultView,
    registeredAgents,
    canRequestSurface:
      args.hostCapabilities?.includes(AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY) === true
  }
  publishMobileStructuredChatLaunch(context)
  return context
}
