import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { isPeerCaller } from '../../../../orchestration/addressing/orchestration-caller-identity'
import { isStructuredWorkerHandle } from '../../../../../../shared/orchestration/workers/structured-worker-handle'
import type {
  OrchestrationPartyIdentity as OrchestrationCallerIdentity,
  OrchestrationPartyIdentity as OrchestrationParty
} from '../../../../../../shared/orchestration/mailbox/orchestration-party-identity'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaSessionId } from '../../../../../../shared/orca-session-address'
import { formatOrcaSessionAddress } from '../../../../../../shared/orca-session-address'
import {
  admitChatAssignee,
  chatAssigneeOf,
  refuseChatSelfAssignment
} from '../chat-assignee-admission'

/** Before any effects, refuse coordinator self-assignment, foreign-workspace panes and terminals without agents. */
export async function assertExplicitWorkerTerminalUsable(args: {
  runtime: OrcaRuntimeService
  terminal: string
  from: string
  coordinator: OrchestrationCallerIdentity | null
  resolvedWorktreeId: string | undefined
}): Promise<void> {
  const { runtime, terminal, from, coordinator, resolvedWorktreeId } = args
  const explicitTerminal = await runtime.showTerminal(terminal)
  const targetPane = runtime.getTerminalPaneKey(terminal)
  const callerPane = coordinator?.paneKey ?? runtime.getTerminalPaneKey(from)
  // Structured coordinators may have no showable terminal; compare their handle/pane identity, or session address for handle-less callers.
  // A paired Orca's coordinator has no terminal here either; its address is its handle.
  const coordinatorHandle =
    coordinator?.terminalHandle === null || isPeerCaller(coordinator)
      ? coordinator.address
      : isStructuredWorkerHandle(from)
        ? from
        : (await runtime.showTerminal(from)).handle
  if (
    explicitTerminal.handle === coordinatorHandle ||
    (targetPane !== null && targetPane === callerPane)
  ) {
    throw new OrchestrationError(
      'terminal_is_coordinator',
      `Terminal ${terminal} is this coordinator's own terminal. Pass --terminal for a different agent pane, or omit it so worker-start creates one.`
    )
  }
  if (explicitTerminal.worktreeId !== resolvedWorktreeId) {
    throw new OrchestrationError(
      'terminal_worktree_mismatch',
      `Terminal ${terminal} does not belong to worktree ${resolvedWorktreeId}.`
    )
  }
  if (!(await runtime.isTerminalRunningAgent(terminal))) {
    throw new OrchestrationError(
      'agent_unconfigured',
      `Terminal ${terminal} is not running a recognized agent.`
    )
  }
}

/** A `--terminal` party: a terminal pane, or a chat named by its Orca session ID. */
export async function assertExplicitWorkerUsable(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  terminal: OrchestrationParty
  from: string
  coordinator: OrchestrationCallerIdentity | null
  resolvedWorktreeId: string | undefined
}): Promise<void> {
  const chat = chatAssigneeOf(args.terminal)
  await (chat
    ? assertExplicitWorkerChatUsable({ ...args, chat })
    : assertExplicitWorkerTerminalUsable({ ...args, terminal: args.terminal.address }))
}

/** The same refusals for a chat named by its Orca session ID: itself, unreachable, another worktree. */
async function assertExplicitWorkerChatUsable(args: {
  runtime: Pick<OrcaRuntimeService, 'ensureStructuredAgentSessionHost'>
  db: OrchestrationDb
  chat: OrcaSessionId
  coordinator: OrchestrationCallerIdentity | null
  resolvedWorktreeId: string | undefined
}): Promise<void> {
  refuseChatSelfAssignment({
    sessionId: args.chat,
    coordinatorSessionId: args.coordinator?.orcaSessionId,
    remedy: 'Pass --terminal for a different agent, or omit it so worker-start creates one.'
  })
  const session = await admitChatAssignee(args.runtime, args.chat, args.db)
  if (session.location.workspaceId !== args.resolvedWorktreeId) {
    throw new OrchestrationError(
      'terminal_worktree_mismatch',
      `${formatOrcaSessionAddress(args.chat)} does not belong to worktree ${args.resolvedWorktreeId}.`
    )
  }
}
