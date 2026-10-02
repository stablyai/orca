/**
 * A worker's dispatch brief offered to its agent's launch command, through the one carry rule
 * (`carryLaunchPrompt`) every launch uses, as main's paste caller (`once-agent-runs`): the brief
 * rides the line where the line carries it exactly, and is otherwise left for worker start's paste
 * once the agent is ready, as main pasted it.
 *
 * Why: a paste races the agent's startup; a fresh Codex lost or truncated worker briefs, and Enter
 * could land on a startup dialog (#23745). The brief names the worker's handle and the CLI command
 * its terminal will run, so both are settled before the spawn.
 */
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import { agentPromptRidesLaunchCommand } from '../../../../../../shared/tui-agent-startup'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { orcaSessionIdOrHandle } from '../../../../orchestration/orchestration-party'
import { buildDispatchPreamble } from '../../../../orchestration/preamble'
import type { TerminalCreateOptions } from '../../../../runtime-terminal-contracts'

export type WorkerLaunchBrief = {
  /** Pre-allocated: the brief names the worker's handle before its terminal exists. */
  handle: string
  text: string
  /** Taken before the spawn: only a prompt-carrying hook turn after it proves the brief landed. */
  launchStartedAt: number
  /** Set by the spawn's carry rule; false leaves the brief for the paste once the agent is ready. */
  carried: boolean
}

/** Where the worker's terminal will spawn: an existing worktree, or one created for a repo. */
export type WorkerLaunchTarget = { worktreeId: string } | { repoSelector: string }

export type WorkerLaunchBriefFactory = (target: WorkerLaunchTarget) => Promise<WorkerLaunchBrief>

export function createWorkerLaunchBriefFactory(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  agent: TuiAgent | undefined
  dispatchId: string
  dispatchDepth: number
  taskId: string
  taskSpec: string
  coordinatorHandle: string
  devMode: boolean | undefined
}): WorkerLaunchBriefFactory | undefined {
  const { runtime, agent } = args
  // Why: an agent that takes its text only after start has no launch command to carry it.
  if (!agent || !agentPromptRidesLaunchCommand(agent)) {
    return undefined
  }
  return async (target) => {
    const handle = runtime.createPreAllocatedTerminalHandle()
    const text = buildDispatchPreamble({
      canDispatchSubWorkers: args.dispatchDepth < runtime.getNestedWorkerMaxDepth(),
      taskId: args.taskId,
      dispatchId: args.dispatchId,
      taskSpec: args.taskSpec,
      coordinatorHandle: orcaSessionIdOrHandle(args.coordinatorHandle, args.db),
      workerHandle: handle,
      devMode: args.devMode,
      cliCommand: await runtime.predictOrchestrationCliCommandForSpawn(target)
    })
    return { handle, text, launchStartedAt: Date.now(), carried: false }
  }
}

/** The create options that offer `brief` to the carry rule; its outcome lands on `brief.carried`. */
export function workerLaunchBriefCreateOptions(
  brief: WorkerLaunchBrief
): Pick<TerminalCreateOptions, 'startupPrompt' | 'startupPromptPaste' | 'onStartupPromptCarry'> {
  return {
    startupPrompt: brief.text,
    // Main pasted worker briefs once the agent was ready, on every host.
    startupPromptPaste: 'once-agent-runs',
    onStartupPromptCarry: (carried) => {
      brief.carried = carried
    }
  }
}
