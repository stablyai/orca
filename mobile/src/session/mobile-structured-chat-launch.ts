import { AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY } from '../../../src/shared/agent-launch-runtime-capability'
import {
  AGENT_SESSION_AGENTS_METHOD,
  decodeAgentSessionAgentsResult
} from '../../../src/shared/agent-session/agent-session-registered-agents'
import { isNativeChatSupportedAgent } from '../../../src/shared/native-chat/native-chat-agent-support'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY } from '../../../src/shared/structured-agent-session-surface-capabilities'
import type { RpcClient } from '../transport/rpc-client'
import {
  hostStatusProbe,
  readProbedHostCapabilities
} from '../transport/host-status-probe-operations'
import { loadDefaultSessionView, type MobileSessionView } from '../storage/session-view-preferences'

export type MobileStructuredChatLaunchContext = {
  defaultView: MobileSessionView
  registeredAgents: readonly string[]
  canRequestSurface: boolean
  // The list this decision used. A launch must not keep the gate's empty placeholder.
  hostCapabilities: readonly string[] | null | undefined
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

// These agents cannot switch a terminal to chat, and Chat UI defaults to off.
export function mobileStructuredChatLaunchSurface(
  agent: string,
  context: MobileStructuredChatLaunchContext | null
): 'chat' | undefined {
  if (!context?.canRequestSurface) {
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

// The new-tab sheet stays open on the gate's empty placeholder and then caches "not chat".
function capabilitySnapshotUnproven(
  hostCapabilities: readonly string[] | null | undefined
): boolean {
  return hostCapabilities == null || hostCapabilities.length === 0
}

async function capabilitiesForStructuredChat(
  client: RpcClient,
  hostCapabilities: readonly string[] | null | undefined
): Promise<readonly string[] | null | undefined> {
  if (!capabilitySnapshotUnproven(hostCapabilities)) {
    return hostCapabilities
  }
  try {
    const reply = await hostStatusProbe.request(client)
    return readProbedHostCapabilities(reply) ?? hostCapabilities
  } catch {
    return hostCapabilities
  }
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
  const hostCapabilities = await capabilitiesForStructuredChat(args.client, args.hostCapabilities)
  const [defaultView, registeredAgents] = await Promise.all([
    loadDefaultSessionView(),
    registeredStructuredAgents(args.client, hostCapabilities)
  ])
  const context: MobileStructuredChatLaunchContext = {
    defaultView,
    registeredAgents,
    canRequestSurface: hostCapabilities?.includes(AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY) === true,
    hostCapabilities
  }
  publishMobileStructuredChatLaunch(context)
  return context
}
