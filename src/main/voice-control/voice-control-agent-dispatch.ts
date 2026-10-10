import { randomUUID } from 'node:crypto'
import { isAgentPromptStalledError } from '../runtime/agent-prompt-submission-verification'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import {
  buildDispatchPreamble,
  type DispatchPreambleSendOptions
} from '../runtime/orchestration/preamble'
import { sendAgentTurn } from '../runtime/orchestration/send-agent-turn'
import type { TuiAgent } from '../../shared/tui-agent'
import type { VoiceRosterEntry } from './voice-control-roster'
import { VOICE_CONTROL_HANDLE } from './voice-control-participant'

/**
 * Sends the user's spoken message into one terminal agent as a full dispatch: task row →
 * dispatch context → coordinator preamble. The ceremony is what buys reply routing — the
 * worker's worker_done lands on the control's run mailbox, correlated by dispatch id.
 * Envelope mirrors dispatchTaskToWorker (coordinator-task-dispatch.ts).
 */

export type VoiceAgentDispatchRuntime = {
  sendTerminalAgentPrompt(
    handle: string,
    prompt: string,
    options: DispatchPreambleSendOptions
  ): Promise<unknown>
  getNestedWorkerMaxDepth(): number
  /** The identity probe behind the CLI's inject preflight — fresh, not roster-stale. */
  isTerminalRunningAgent(handle: string): Promise<boolean>
  getTerminalOrchestrationCliCommand?(
    handle: string
  ): Parameters<typeof buildDispatchPreamble>[0]['cliCommand']
}

export type VoiceAgentDispatchDeps = {
  db: OrchestrationDb
  runtime: VoiceAgentDispatchRuntime
  runId: string
  terminalHandleForPaneKey: (paneKey: string) => string | null
}

export type VoiceAgentDispatchResult =
  | { kind: 'dispatched'; dispatchId: string }
  /** The prompt is in the pane but the turn start was never observed; still counts. */
  | { kind: 'dispatched-unobserved'; dispatchId: string }
  /** The pane's terminal is a bare shell — the roster row was stale. Nothing written. */
  | { kind: 'no-agent-detected' }
  | { kind: 'unreachable'; reason: string }

/**
 * The ceremony both entry points share: task row → dispatch context → coordinator
 * preamble. The preamble is what buys reply routing — the worker's worker_done lands on
 * the control's run mailbox, correlated by dispatch id.
 */
function prepareVoiceDispatch(
  db: OrchestrationDb,
  args: {
    runId: string
    message: string
    spokenName: string
    handle: string
    /** Absent on a fresh launch — the pane does not exist yet. */
    paneKey?: string
    maxDepth: number
    cliCommand?: Parameters<typeof buildDispatchPreamble>[0]['cliCommand']
  }
): { preamble: string; dispatchId: string; title: string } {
  const title = args.message.slice(0, 80)
  const task = db.createTask({
    spec: args.message,
    runId: args.runId,
    taskTitle: title,
    displayName: args.spokenName
  })
  const dispatch = db.createDispatchContext({
    taskId: task.id,
    assigneeHandle: args.handle,
    ...(args.paneKey !== undefined ? { assigneePaneKey: args.paneKey } : {}),
    // Why system: the control is host-local Orca code, a root by construction.
    creator: { kind: 'system' },
    maxDepth: args.maxDepth
  })
  const preamble = buildDispatchPreamble({
    taskId: task.id,
    dispatchId: dispatch.id,
    taskSpec: args.message,
    coordinatorHandle: VOICE_CONTROL_HANDLE,
    workerHandle: args.handle,
    canDispatchSubWorkers: false,
    // Why: agents inside a dev app must reach the dev runtime's socket, not production.
    devMode: process.env.ORCA_USER_DATA_PATH?.includes('orca-dev'),
    ...(args.cliCommand !== undefined ? { cliCommand: args.cliCommand } : {})
  })
  return { preamble, dispatchId: dispatch.id, title }
}

export async function dispatchVoiceMessageToAgent(
  deps: VoiceAgentDispatchDeps,
  entry: VoiceRosterEntry,
  message: string
): Promise<VoiceAgentDispatchResult> {
  const handle = deps.terminalHandleForPaneKey(entry.paneKey)
  if (!handle) {
    return { kind: 'unreachable', reason: 'no live terminal behind that pane' }
  }
  // The roster is stale-tolerant by design, so a pane whose agent exited since the last
  // status write is a bare shell — and a preamble typed into a bare shell never becomes
  // a turn, leaving a zombie dispatch context that blocks every later dispatch to that
  // terminal (live: ctx_811550c45b61 wedged main 2 for an hour). The CLI's dispatch
  // --inject runs this same probe first and refuses with inject_rejected/no_agent_detected.
  if (!(await deps.runtime.isTerminalRunningAgent(handle))) {
    return { kind: 'no-agent-detected' }
  }
  const { preamble, dispatchId } = prepareVoiceDispatch(deps.db, {
    runId: deps.runId,
    message,
    spokenName: entry.spokenName,
    handle,
    paneKey: entry.paneKey,
    maxDepth: deps.runtime.getNestedWorkerMaxDepth(),
    ...(deps.runtime.getTerminalOrchestrationCliCommand
      ? { cliCommand: deps.runtime.getTerminalOrchestrationCliCommand(handle) }
      : {})
  })
  try {
    await sendAgentTurn({
      kind: 'terminal',
      runtime: deps.runtime,
      handle,
      turn: { purpose: 'dispatch-preamble', body: preamble, operationId: dispatchId }
    })
  } catch (error) {
    // Why (#16095 posture): Enter lands before submission is verified, so a stall is only
    // ever an unobserved turn start — never proof the preamble is missing. The dispatch
    // stays live; the reply pump still collects the outcome.
    if (isAgentPromptStalledError(error)) {
      return { kind: 'dispatched-unobserved', dispatchId }
    }
    throw error
  }
  return { kind: 'dispatched', dispatchId }
}

export type VoiceAgentLaunchDeps = {
  db: OrchestrationDb
  runId: string
  getNestedWorkerMaxDepth: () => number
  getOrchestrationCliCommand?: (
    handle: string
  ) => Parameters<typeof buildDispatchPreamble>[0]['cliCommand']
  launchAgentTerminal: (opts: {
    worktreeId: string
    agent: TuiAgent
    prompt: string
    title: string
    preAllocatedHandle: string
  }) => Promise<unknown>
}

export type VoiceAgentLaunchResult =
  | { kind: 'launched'; handle: string }
  | { kind: 'unreachable'; reason: string }

/**
 * start_agent's ceremony for a worktree with no running agent. Same task/dispatch/preamble
 * as a live dispatch, but the preamble is the terminal's STARTUP prompt — the handle is
 * pre-allocated because the preamble's `--from <handle>` orchestration commands must name
 * the worker before its PTY exists. The worker reports to the voice run's mailbox exactly
 * like a messaged agent, so follow-through (pump + watchdog) is unchanged.
 */
export async function launchVoiceAgentInWorktree(
  deps: VoiceAgentLaunchDeps,
  entry: VoiceRosterEntry,
  agent: TuiAgent,
  message: string
): Promise<VoiceAgentLaunchResult> {
  const handle = `term_${randomUUID()}`
  const { preamble, title } = prepareVoiceDispatch(deps.db, {
    runId: deps.runId,
    message,
    spokenName: entry.spokenName,
    handle,
    maxDepth: deps.getNestedWorkerMaxDepth(),
    ...(deps.getOrchestrationCliCommand
      ? { cliCommand: deps.getOrchestrationCliCommand(handle) }
      : {})
  })
  try {
    await deps.launchAgentTerminal({
      worktreeId: entry.worktreeId,
      agent,
      prompt: preamble,
      title,
      preAllocatedHandle: handle
    })
  } catch (error) {
    return {
      kind: 'unreachable',
      reason: error instanceof Error ? error.message : String(error)
    }
  }
  return { kind: 'launched', handle }
}
