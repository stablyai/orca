/**
 * Issuing a mobile workspace create through `agent.launch` rather than `worktree.create`.
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
  type AgentLaunchResult
} from '../../../src/shared/agent-launch-intent'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import type { RpcSendParams } from '../transport/rpc-params-contract'
import type { WorkspaceCreateParams } from './workspace-create-params'

export type WorktreeCreateAgentLaunch = {
  agent: TuiAgent
  /** Resolved before the first create: an older host has no `agent.launch` at all. */
  supported: boolean | Promise<boolean>
}

/** `worktreeId` is tied to the shared contract so a change to it fails this reader's typecheck
 *  rather than silently passing a differently-typed field through. */
export type AgentLaunchCreateOutcome = {
  worktreeId: AgentLaunchResult['worktreeId']
  warning?: string
}

export function agentLaunchCreateParams(
  agent: TuiAgent,
  create: WorkspaceCreateParams
): RpcSendParams<'agent.launch'> {
  return {
    agent,
    target: { kind: 'create-worktree', create: withoutReservedAgentCreateFields(create) }
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
  // A current host reports an incomplete create at the top level, the same place `worktree.create`
  // puts it, so nothing here branches on which surface the host built to find it. A host that
  // predates that move nests the same warning on the terminal outcome instead, and still advertises
  // the one `agent.launch.v1` capability, so this route cannot tell the two apart up front — read
  // both shapes for as long as such a host can be paired. Top level wins: it is the only place a
  // current host writes, so the fallback cannot shadow a fresher value.
  const warning =
    readTrimmedWarning(result) || readTrimmedWarning('outcome' in result ? result.outcome : null)
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
 * `agent.launch.v1` but has not yet recorded this client's own capability list, and then refuses
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
