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

export const AGENT_LAUNCH_METHOD = 'agent.launch' as const

export type WorktreeCreateAgentLaunch = {
  agent: TuiAgent
  /** Resolved before the first create: an older host has no `agent.launch` at all. */
  supported: boolean | Promise<boolean>
}

export type AgentLaunchCreateOutcome = { worktreeId: string }

export function agentLaunchCreateParams(
  agent: TuiAgent,
  create: Record<string, unknown>
): Record<string, unknown> {
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
 * marking decides what opens. That is why nothing here branches on `outcome.kind` — a create-time
 * guess would just race the snapshot that already knows.
 */
export function readAgentLaunchCreateOutcome(result: unknown): AgentLaunchCreateOutcome | null {
  if (!result || typeof result !== 'object') {
    return null
  }
  const worktreeId = (result as Partial<AgentLaunchResult>).worktreeId
  if (typeof worktreeId !== 'string' || !worktreeId.trim()) {
    return null
  }
  return { worktreeId }
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
