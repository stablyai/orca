import { WindowsCmdLineBreakError } from '@orca/process-host'
import type { CommitMessagePlan } from '../../shared/commit-message-plan'
import { commandLineLength, MAX_COMMAND_LINE_CHARS } from '../../shared/windows-command-line-budget'
import { supervisedProviderSpawnFailure } from '../provider-process/provider-spawn-failure-report'
import { stopSupervisedChildProcess } from '../provider-process/supervised-child-process-stop'
import { terminateWindowsProcessTree } from '../windows-process-tree-kill'
import {
  finalizeFromAgentOutput,
  userFacingUnsafeWindowsBatchArgs
} from './source-control-agent-failure'
import {
  clearLocalGenerationCancelToken,
  localGenerationLaneKey,
  setLocalGenerationCancelToken
} from './source-control-generation-lanes'
import {
  MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES,
  SOURCE_CONTROL_GENERATION_TIMEOUT_MS
} from './source-control-generation-limits'
import type {
  InternalTextGenerationResult,
  LocalProcessExecution,
  SpawnedSourceControlAgentProcess,
  SpawnSourceControlAgent,
  TextGenerationOperation
} from './source-control-text-generation-types'

export const SOURCE_CONTROL_KILL_SITE = 'source-control-text-generation'

export async function killSourceControlAgentProcess(
  child: SpawnedSourceControlAgentProcess
): Promise<void> {
  const pid = child.pid
  if (!pid) {
    return
  }
  if (child.supervised) {
    await stopSupervisedChildProcess(child, { site: SOURCE_CONTROL_KILL_SITE })
    return
  }
  if (process.platform === 'win32') {
    // Tree-walk refusal must not release the home lock having killed nothing; root handle kill cannot hit a recycled PID.
    await terminateWindowsProcessTree(pid, { site: SOURCE_CONTROL_KILL_SITE })
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // The process may exit between the PID check and kill.
  }
}

// Linux caps each argv entry in bytes (128KiB on 4KiB pages), before total argv capacity; reserve headroom for single-prompt arguments.
const LINUX_SINGLE_ARGUMENT_BYTE_BUDGET = 120 * 1024

/** Whether the plan's argv plus reserve fits this host's limit: UTF-16 units on Windows, bytes per argument on Linux. */
export function fitsLocalCommandLine(plan: CommitMessagePlan, reserve = 0): boolean {
  if (process.platform === 'win32') {
    return commandLineLength([plan.binary, ...plan.args]) + reserve <= MAX_COMMAND_LINE_CHARS
  }
  if (process.platform === 'linux') {
    return plan.args.every(
      (arg) => Buffer.byteLength(arg, 'utf8') + reserve <= LINUX_SINGLE_ARGUMENT_BYTE_BUDGET
    )
  }
  return true
}

function argumentBudgetFailure(plan: CommitMessagePlan): string | null {
  if (fitsLocalCommandLine(plan)) {
    return null
  }
  return process.platform === 'win32'
    ? `${plan.label} prompt is too large for the Windows command line. Stage fewer changes and try again.`
    : `${plan.label} prompt is too large to pass as a single command-line argument. Stage fewer changes and try again.`
}

export function runLocalSourceControlPlan(input: {
  plan: CommitMessagePlan
  cwd: string
  env: NodeJS.ProcessEnv | undefined
  emptyResultName: string
  operation: TextGenerationOperation
  wslDistro?: string
  spawnAgent: SpawnSourceControlAgent
}): LocalProcessExecution<InternalTextGenerationResult> {
  const { plan, cwd, operation } = input
  let markProcessClosed!: () => void
  const processClosed = new Promise<void>((resolve) => {
    markProcessClosed = resolve
  })
  const couldNotStart = `${plan.label} could not be started. Check the agent command in Settings and try again.`
  const result = new Promise<InternalTextGenerationResult>((resolve) => {
    let child: SpawnedSourceControlAgentProcess
    try {
      // Reject oversized argv before opaque E2BIG spawn failure so users can act on the prompt-size limit.
      const budgetFailure = argumentBudgetFailure(plan)
      if (budgetFailure) {
        markProcessClosed()
        resolve({ success: false, error: budgetFailure })
        return
      }
      child = input.spawnAgent({
        binary: plan.binary,
        args: plan.args,
        cwd,
        env: input.env,
        commandEnv: plan.env,
        wslDistro: input.wslDistro,
        stdinMode: 'pipe',
        useCwdForNative: true
      })
    } catch (error) {
      markProcessClosed()
      if (error instanceof WindowsCmdLineBreakError) {
        resolve({
          success: false,
          error: userFacingUnsafeWindowsBatchArgs(plan.label)
        })
        return
      }
      console.error('[commit-message] Failed to spawn local generator:', error)
      resolve({ success: false, error: couldNotStart })
      return
    }

    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let outputLimitExceeded = false
    let settled = false
    let canceledByUser = false
    const laneKey = localGenerationLaneKey(operation, cwd)
    let timer: ReturnType<typeof setTimeout> | null = null
    let terminal = false
    let terminationComplete: Promise<void> | null = null
    let detachChildListeners = (): void => {}
    const startTermination = (): void => {
      terminationComplete ??= killSourceControlAgentProcess(child).catch((error: unknown) => {
        console.error('[commit-message] Local generator termination failed:', error)
      })
    }
    const markClosedAfterTermination = (): void => {
      if (terminal && settled) {
        void (terminationComplete ?? Promise.resolve()).then(markProcessClosed)
      }
    }
    const finalize = (value: InternalTextGenerationResult): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      detachChildListeners()
      clearLocalGenerationCancelToken(laneKey, cancel)
      resolve(value)
      markClosedAfterTermination()
    }
    const cancel = (): void => {
      canceledByUser = true
      startTermination()
      finalize({
        success: false,
        error: 'Generation canceled.',
        canceled: true
      })
    }
    setLocalGenerationCancelToken(laneKey, cancel)
    timer = setTimeout(() => {
      startTermination()
      finalize({
        success: false,
        error: `Generation timed out after ${SOURCE_CONTROL_GENERATION_TIMEOUT_MS / 1000}s.`
      })
    }, SOURCE_CONTROL_GENERATION_TIMEOUT_MS)

    const onStdoutData = (chunk: Buffer): void => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES) {
        outputLimitExceeded = true
        startTermination()
        return
      }
      stdout += chunk.toString('utf-8')
    }
    const onStderrData = (chunk: Buffer): void => {
      stderrBytes += chunk.byteLength
      if (stderrBytes > MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES) {
        outputLimitExceeded = true
        startTermination()
        return
      }
      stderr += chunk.toString('utf-8')
    }
    const onError = (error: Error): void => {
      if (!child.pid) {
        markProcessClosed()
      } else if (!terminal && child.exitCode == null && child.signalCode == null) {
        startTermination()
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        finalize({
          success: false,
          error: `${plan.binary} not found on PATH. Install ${plan.label} to use AI commit messages.`
        })
        return
      }
      console.error('[commit-message] Local generator failed after spawn:', error)
      finalize({
        success: false,
        error: `${plan.label} failed to start. Check the agent command in Settings and try again.`
      })
    }
    const onClose = (code: number | null): void => {
      terminal = true
      child.off?.('close', onClose)
      markClosedAfterTermination()
      if (canceledByUser) {
        finalize({
          success: false,
          error: 'Generation canceled.',
          canceled: true
        })
        return
      }
      if (outputLimitExceeded) {
        finalize({
          success: false,
          error: `${plan.label} CLI command produced too much output. Check the agent CLI configuration and try again.`
        })
        return
      }
      const spawnFailure = supervisedProviderSpawnFailure(code, stderr)
      if (spawnFailure?.thrown) {
        console.error('[commit-message] Failed to spawn local generator:', spawnFailure.error)
        finalize({ success: false, error: couldNotStart })
        return
      }
      if (spawnFailure) {
        onError(spawnFailure.error)
        return
      }
      finalize(
        finalizeFromAgentOutput({
          code,
          stdout,
          stderr,
          label: plan.label,
          outputFormat: plan.outputFormat,
          emptyResultName: input.emptyResultName,
          includeStdoutDetail: operation !== 'branch-name' && operation !== 'conversation-name'
        })
      )
    }
    child.stdout?.on('data', onStdoutData)
    child.stderr?.on('data', onStderrData)
    child.on('error', onError)
    child.on('close', onClose)
    child.on('exit', () => {
      terminal = true
      markClosedAfterTermination()
    })
    detachChildListeners = () => {
      child.stdout?.off?.('data', onStdoutData)
      child.stderr?.off?.('data', onStderrData)
    }
    try {
      child.stdin?.end(plan.stdinPayload ?? undefined)
    } catch (error) {
      startTermination()
      onError(error instanceof Error ? error : new Error(String(error)))
    }
  })
  return { result, processClosed }
}
