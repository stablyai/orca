import { RuntimeClientError, RuntimeRpcFailureError } from './runtime-client'
import { classifyAgentLaunchReplayRefusal } from '../shared/agent-launch-replay-refusal'
import { DEFAULT_LAUNCH_AGENT_SELECTOR } from '../shared/default-launch-agent'
import {
  recoverableOrchestrationArgs,
  resolveOrchestrationCliExecutable
} from './runtime/orchestration-recovery-command'

function launchedAgentOf(params: unknown): string | undefined {
  return typeof params === 'object' &&
    params !== null &&
    'agent' in params &&
    typeof params.agent === 'string'
    ? params.agent
    : undefined
}

/** A replay must name the agent the host admitted; `default` could resolve differently later. */
function pinDefaultAgent(args: string[], agent: string | undefined): boolean {
  let pinned = false
  for (let index = 0; index < args.length && agent; index++) {
    if (args[index] === '--agent' && args[index + 1] === DEFAULT_LAUNCH_AGENT_SELECTOR) {
      args[index + 1] = agent
      pinned = true
    } else if (args[index] === `--agent=${DEFAULT_LAUNCH_AGENT_SELECTOR}`) {
      args[index] = `--agent=${agent}`
      pinned = true
    }
  }
  return pinned
}

/** A lost reply never authorizes a new launch, even on hosts without a replay ledger. */
export async function withCliAgentLaunchRecovery<T>(
  launch: Promise<T>,
  recovery: {
    operationId?: string
    replayed?: boolean
    rawArgs?: readonly string[]
    params: unknown
  }
): Promise<T> {
  try {
    return await launch
  } catch (error) {
    // A replay method's ordinary refusal proves no effects; legacy errors may follow a spawn.
    if (
      recovery.operationId &&
      error instanceof RuntimeRpcFailureError &&
      error.code !== 'runtime_error' &&
      classifyAgentLaunchReplayRefusal(error, recovery.replayed === true) !== 'unknown'
    ) {
      throw error
    }
    // Keep the setup choice's pre-launch refusal intact for the CLI's existing recovery.
    if (
      error instanceof RuntimeClientError &&
      error.message === 'Setup decision required for this repository'
    ) {
      throw error
    }
    const args = recovery.rawArgs && recoverableOrchestrationArgs(recovery.rawArgs)
    const retryArgs: string[] = []
    for (let index = 0; index < (args?.length ?? 0); index++) {
      const arg = args?.[index]
      if (arg === '--retry-launch') {
        index++
      } else if (arg && !arg.startsWith('--retry-launch=')) {
        retryArgs.push(arg)
      }
    }
    const launchedAgent = launchedAgentOf(recovery.params)
    const pinnedAgent = pinDefaultAgent(retryArgs, launchedAgent)
    // Why from rawArgs: credential flags suppress `args`, but the default still needs pinning.
    const usedDefaultAgent =
      launchedAgent !== undefined && pinDefaultAgent([...(recovery.rawArgs ?? [])], launchedAgent)
    const recoveryCommand =
      args && recovery.operationId
        ? [
            resolveOrchestrationCliExecutable(),
            ...retryArgs,
            '--retry-launch',
            recovery.operationId
          ]
        : undefined
    const nextSteps = recovery.operationId
      ? [
          pinnedAgent
            ? `Re-issue recoveryCommand from the same directory against the same execution host. It names --agent ${launchedAgent}, the agent --agent default resolved to; keep that agent and --retry-launch ${recovery.operationId} on every retry, and never retry as a fresh launch.`
            : usedDefaultAgent
              ? `Re-issue the same command from the same directory against the same execution host, with the same pairing or environment flags, but replace --agent default with --agent ${launchedAgent} (the agent it resolved to, also in launchRequest.agent) and add --retry-launch ${recovery.operationId}. Keep both on every retry; --retry-launch refuses --agent default, and never retry as a fresh launch.`
              : `Re-issue the exact same command from the same directory against the same execution host with --retry-launch ${recovery.operationId}. Keep that ID on every retry; never retry as a fresh launch.`,
          'If replay reports an unknown or expired outcome, inspect the workspace and agent without sending input before deciding what to do.'
        ]
      : [
          'Do not repeat the launch: this older host cannot prove whether it started the agent or sent the prompt.',
          'Inspect worktree list and terminal list on the execution host, then read the agent without sending input. Confirm the outcome before deliberately starting another agent.'
        ]
    // Replace transport restart-and-retry advice: the accepted launch may still be running.
    throw new RuntimeClientError(
      'agent_session_operation_unknown',
      'Orca could not confirm the launch outcome; the agent may already be running and the prompt may already be submitted.',
      {
        launchOutcome: 'unknown',
        retrySafe: Boolean(recovery.operationId),
        ...(recovery.operationId ? { operationId: recovery.operationId } : {}),
        launchRequest: recovery.params,
        ...(recoveryCommand ? { recoveryCommand } : {}),
        nextSteps,
        cause:
          error instanceof Error
            ? error.message.replace(/\bRestart Orca and try again\./g, '')
            : String(error)
      }
    )
  }
}
