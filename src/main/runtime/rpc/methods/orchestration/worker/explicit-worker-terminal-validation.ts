import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { isStructuredWorkerHandle } from '../../../../structured-worker-identity'
import type { OrchestrationCallerIdentity } from '../../../../orchestration/orchestration-caller-identity'
import type { OrchestrationParty } from '../../../../orchestration/orchestration-party'
import { readAgentSessionRecordStore } from '../../../../orchestration/structured-session-lineage'
import { assertChatAssigneeReachable } from '../messaging/session-recipient'

/**
 * Admits a caller-supplied `--terminal` as this dispatch's worker pane, or a chat by its address.
 *
 * Three refusals, all of which must happen before anything is created: a coordinator adopted as its
 * own worker answers its own dispatch preamble forever, a pane in another worktree is not this
 * dispatch's to take, and a pane with no agent cannot read a preamble at all.
 */
export async function assertExplicitWorkerTerminalUsable(args: {
  runtime: OrcaRuntimeService
  terminal: OrchestrationParty
  from: string
  coordinator: OrchestrationCallerIdentity | null
  resolvedWorktreeId: string | undefined
}): Promise<void> {
  const { runtime, from, coordinator, resolvedWorktreeId } = args
  if (args.terminal.terminalHandle === null) {
    await assertExplicitWorkerChatUsable({ ...args, chat: args.terminal })
    return
  }
  const terminal = args.terminal.address
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
    throw coordinatorItselfRefusal(terminal)
  }
  if (explicitTerminal.worktreeId !== resolvedWorktreeId) {
    throw otherWorktreeRefusal(terminal, resolvedWorktreeId)
  }
  if (!(await runtime.isTerminalRunningAgent(terminal))) {
    throw new OrchestrationError(
      'agent_unconfigured',
      `Terminal ${terminal} is not running a recognized agent.`
    )
  }
}

/** The same three refusals for a chat named by its address: itself, another worktree, unreachable. */
async function assertExplicitWorkerChatUsable(args: {
  runtime: OrcaRuntimeService
  chat: OrchestrationParty
  coordinator: OrchestrationCallerIdentity | null
  resolvedWorktreeId: string | undefined
}): Promise<void> {
  const { runtime, chat } = args
  if (chat.address === args.coordinator?.address) {
    throw coordinatorItselfRefusal(chat.address)
  }
  const db = runtime.getOrchestrationDb()
  await assertChatAssigneeReachable(runtime, chat, db)
  const record = chat.orcaSessionId
    ? readAgentSessionRecordStore()?.getRecord(chat.orcaSessionId)
    : null
  if (record?.location.workspaceId !== args.resolvedWorktreeId) {
    throw otherWorktreeRefusal(chat.address, args.resolvedWorktreeId)
  }
}

/** One wording for a terminal and a chat alike; only the address differs. */
function coordinatorItselfRefusal(address: string): OrchestrationError {
  return new OrchestrationError(
    'terminal_is_coordinator',
    `${address} is this coordinator's own address. Pass --terminal for a different agent, or omit it so worker-start creates one.`
  )
}

function otherWorktreeRefusal(address: string, worktreeId: string | undefined): OrchestrationError {
  return new OrchestrationError(
    'terminal_worktree_mismatch',
    `${address} does not belong to worktree ${worktreeId}.`
  )
}
