// agent.launch lets the host choose chat or PTY; worktree.create with startupAgent forces an agent-first terminal.
// Build from existing create params and strip reserved agent fields so the legacy fallback stays equivalent.

import {
  withoutReservedAgentCreateFields,
  type AgentLaunchPlacement,
  type AgentLaunchPrompt,
  type AgentLaunchResult
} from '../../../src/shared/agent-launch-intent'
import {
  AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_RUNTIME_CAPABILITY
} from '../../../src/shared/agent-launch-runtime-capability'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import type { RpcSendParams } from '../transport/rpc-params-contract'
import type { WorkspaceCreateParams } from './workspace-create-params'

// False identifies older hosts without agent.launch.
export type AgentLaunchSupport = {
  replay: boolean
}

export function readAgentLaunchSupport(
  capabilities: readonly string[] | null | undefined
): AgentLaunchSupport | false {
  if (!capabilities?.includes(AGENT_LAUNCH_RUNTIME_CAPABILITY)) {
    return false
  }
  return { replay: capabilities.includes(AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY) }
}

export type WorktreeCreateAgentLaunch = {
  agent: TuiAgent
  supported: AgentLaunchSupport | false | Promise<AgentLaunchSupport | false>
}

export type AgentLaunchCreateOutcome = {
  worktreeId: AgentLaunchResult['worktreeId']
  warning?: string
}

export function agentLaunchCreateParams(
  agent: TuiAgent,
  create: WorkspaceCreateParams,
  operationId?: string | null
): RpcSendParams<'agent.launch'> {
  return {
    agent,
    ...(operationId ? { operationId } : {}),
    target: { kind: 'create-worktree', create: withoutReservedAgentCreateFields(create) }
  }
}

// Use the separate replay method: older hosts would strip operationId from agent.launch and run an unprotected duplicate.
export function agentLaunchExistingParams(args: {
  agent: TuiAgent
  worktreeId: string
  operationId: string
  prompt?: AgentLaunchPrompt
  launchSource?: string
  paneKey?: string
  sessionId?: string
  placement?: AgentLaunchPlacement
  sessionOptions?: Readonly<Record<string, string>>
  chatOptions?: Readonly<Record<string, string>>
}): RpcSendParams<'agent.launchReplay'> {
  return {
    agent: args.agent,
    operationId: args.operationId,
    target: { kind: 'existing', worktree: `id:${args.worktreeId}` },
    ...(args.prompt ? { prompt: args.prompt } : {}),
    ...(args.sessionOptions ? { sessionOptions: { ...args.sessionOptions } } : {}),
    ...(args.chatOptions ? { chatOptions: { ...args.chatOptions } } : {}),
    ...(args.launchSource ? { launchSource: args.launchSource } : {}),
    ...(args.paneKey ? { paneKey: args.paneKey } : {}),
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(args.placement ? { placement: args.placement } : {})
  }
}

// The host publishes and activates its chosen surface before replying; navigate to the workspace without racing that snapshot.
export function readAgentLaunchCreateOutcome(result: unknown): AgentLaunchCreateOutcome | null {
  if (!result || typeof result !== 'object' || !('worktreeId' in result)) {
    return null
  }
  const worktreeId = result.worktreeId
  if (typeof worktreeId !== 'string' || !worktreeId.trim()) {
    return null
  }
  const warning = readTrimmedWarning(result)
  return { worktreeId, ...(warning ? { warning } : {}) }
}

function readTrimmedWarning(source: unknown): string {
  if (!source || typeof source !== 'object' || !('warning' in source)) {
    return ''
  }
  return typeof source.warning === 'string' ? source.warning.trim() : ''
}

// Capability probing can beat this client’s advertisement; method refusal permits legacy create fallback.
export function isAgentLaunchUnsupportedRefusal(error: {
  code?: string
  message?: string
}): boolean {
  if (error.code === 'method_not_found' || error.code === 'forbidden') {
    return true
  }
  return (error.message ?? '').includes('agent_launch_unsupported')
}

export { isAgentLaunchReplayUnsupportedRefusal } from '../../../src/shared/agent-launch-replay-refusal'
