/**
 * Building mobile's `agent.launch` requests and reading their answers: a workspace create, and a
 * launch into a workspace that already exists.
 *
 * The create half issues a mobile workspace create through `agent.launch` rather than
 * `worktree.create`.
 *
 * `worktree.create` + `startupAgent` means "create the worktree agent-first": its startup terminal
 * IS the agent, so the structured branch below it is unreachable. That is why picking an agent on
 * the mobile create sheet always produced a PTY while the in-workspace "+" button produced a chat.
 * `agent.launch` carries the same create payload but lets the host settle the surface, so both
 * mobile entry points route the same way.
 *
 * The request is built from the caller's existing `worktree.create` params so the fallback path
 * stays byte-identical; the reserved agent fields are stripped here with the shared helper the
 * host applies anyway.
 */

import {
  withoutReservedAgentCreateFields,
  type AgentLaunchPrompt,
  type AgentLaunchResult
} from '../../../src/shared/agent-launch-intent'
import {
  AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import type { RpcSendParams } from '../transport/rpc-params-contract'
import type { WorkspaceCreateParams } from './workspace-create-params'

/** What this host's `agent.launch` can do, in the `| false` shape `worktree.create`'s own
 *  idempotency probe already uses: `false` is an older host with no `agent.launch` at all. */
export type AgentLaunchSupport = {
  /** The host deduplicates operationId durably and refuses unknown or expired outcomes. */
  replay: boolean
}

/** Reads the host's advertised capabilities; unsupported stays plain `false`. */
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
  /** Resolved before the first create: an older host has no `agent.launch` at all. */
  supported: AgentLaunchSupport | false | Promise<AgentLaunchSupport | false>
}

/** `worktreeId` is tied to the shared contract so a change to it fails this reader's typecheck
 *  rather than silently passing a differently-typed field through. */
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

/**
 * A launch into a workspace that already exists. Always sent as `agent.launchReplay`: a host that
 * predates `operationId` would strip it and run the launch unprotected, while the separate method
 * makes such a host refuse instead.
 */
export function agentLaunchExistingParams(args: {
  agent: TuiAgent
  worktreeId: string
  operationId: string
  prompt?: AgentLaunchPrompt
  launchSource?: string
}): RpcSendParams<'agent.launchReplay'> {
  return {
    agent: args.agent,
    operationId: args.operationId,
    target: { kind: 'existing', worktree: `id:${args.worktreeId}` },
    ...(args.prompt ? { prompt: args.prompt } : {}),
    ...(args.launchSource ? { launchSource: args.launchSource } : {})
  }
}

/**
 * Reads the launch receipt.
 *
 * Deliberately mode-blind: whichever surface the host built, it published and activated that tab
 * before answering, so the create flow navigates to the workspace and the host's own active-tab
 * marking decides what opens. That is why nothing here branches on `outcome.kind` to pick a
 * destination — a create-time guess would just race the snapshot that already knows.
 */
export function readAgentLaunchCreateOutcome(result: unknown): AgentLaunchCreateOutcome | null {
  if (!result || typeof result !== 'object' || !('worktreeId' in result)) {
    return null
  }
  const worktreeId = result.worktreeId
  if (typeof worktreeId !== 'string' || !worktreeId.trim()) {
    return null
  }
  // v2 guarantees that an incomplete create is reported at the top level, the same place
  // `worktree.create` puts it, so nothing here branches on which surface the host built.
  const warning = readTrimmedWarning(result)
  return { worktreeId, ...(warning ? { warning } : {}) }
}

function readTrimmedWarning(source: unknown): string {
  if (!source || typeof source !== 'object' || !('warning' in source)) {
    return ''
  }
  return typeof source.warning === 'string' ? source.warning.trim() : ''
}

/**
 * Whether the host rejected the method itself rather than the create.
 *
 * The `status.get` probe can be stale in one direction that matters: the host advertises
 * `agent.launch.v2` but has not yet recorded this client's own capability list, and then refuses
 * the call. Downgrading to `worktree.create` keeps that race from failing a create outright.
 */
export function isAgentLaunchUnsupportedRefusal(error: {
  code?: string
  message?: string
}): boolean {
  if (error.code === 'method_not_found' || error.code === 'forbidden') {
    return true
  }
  return (error.message ?? '').includes('agent_launch_unsupported')
}

/** The `agent.launchReplay` twin: an older host rejects the method rather than a field. */
export function isAgentLaunchReplayUnsupportedRefusal(error: { code?: string }): boolean {
  return (
    error.code === 'method_not_found' ||
    error.code === 'forbidden' ||
    error.code === 'agent_launch_replay_unsupported'
  )
}
