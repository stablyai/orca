import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { isStructuredWorkerHandle } from '../../../../structured-worker-identity'
import type { OrchestrationCallerIdentity } from '../../../../orchestration/orchestration-caller-identity'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrcaSessionId } from '../../../../../../shared/orca-session-address'
import { formatOrcaSessionAddress } from '../../../../../../shared/orca-session-address'
import {
  admitChatAssignee,
  chatAssigneeOf,
  refuseChatSelfAssignment
} from '../chat-assignee-admission'
import type { OrchestrationParty } from '../../../../orchestration/orchestration-party'

/**
 * Admits a caller-supplied `--terminal` as this dispatch's worker pane.
 *
 * Three refusals, all of which must happen before anything is created: a coordinator adopted as its
 * own worker answers its own dispatch preamble forever, a pane in another worktree is not this
 * dispatch's to take, and a pane with no agent cannot read a preamble at all.
 */
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
  // A structured coordinator has no terminal to show, so its own identity is the raw handle plus
  // the pane key; showing `from` unconditionally would throw for exactly those callers. A
  // handle-less session has no terminal at all, so its address is its identity.
  const coordinatorHandle =
    coordinator?.terminalHandle === null
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
