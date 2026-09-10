import type { CommitMessagePlan } from '../../shared/commit-message-plan'
import { UnsafeWindowsBatchArgumentsError } from '../win32-utils'
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

export async function killSourceControlAgentProcess(
  child: SpawnedSourceControlAgentProcess
): Promise<void> {
  const pid = child.pid
  if (!pid) {
    return
  }
  if (process.platform === 'win32') {
    // taskkill owns the tree, but the own-Chromium gate can refuse the
    // pid-addressed walk; the handle-addressed root kill below cannot reach the
    // recycled pid it refused, and callers release the managed-home lock on this
    // promise, so it must not resolve having killed nothing.
    await terminateWindowsProcessTree(pid, { site: 'source-control-text-generation' })
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // The process may exit between the PID check and kill.
  }
}

// Why: Windows caps the CreateProcess command line at 32,767 UTF-16 code units,
// including the executable path, per-arg quoting, and separators. The budget
// leaves headroom for cmd.exe `/d /c` shim wrappers.
const WINDOWS_COMMAND_LINE_UNIT_BUDGET = 30_000

function exceedsWindowsCommandLineBudget(command: string, args: string[]): boolean {
  let units = command.length + args.length
  for (const arg of args) {
    units += arg.length + 2
  }
  return units > WINDOWS_COMMAND_LINE_UNIT_BUDGET
}

export function runLocalSourceControlPlan(input: {
  plan: CommitMessagePlan
  cwd: string
  env: NodeJS.ProcessEnv | undefined
  emptyResultName: string
  operation: TextGenerationOperation
  wslDistro?: string
  holdHomeLockUntilExit: boolean
  spawnAgent: SpawnSourceControlAgent
}): LocalProcessExecution<InternalTextGenerationResult> {
  const { plan, cwd, operation, holdHomeLockUntilExit } = input
  let markProcessClosed!: () => void
  const processClosed = new Promise<void>((resolve) => {
    markProcessClosed = resolve
  })
  const result = new Promise<InternalTextGenerationResult>((resolve) => {
    let child: SpawnedSourceControlAgentProcess
    try {
      if (process.platform === 'win32' && exceedsWindowsCommandLineBudget(plan.binary, plan.args)) {
        markProcessClosed()
        resolve({
          success: false,
          // Why: jcode rides the whole prompt on argv; a large staged diff would
          // exceed Windows' 32,767-unit command line and fail to spawn at all.
          error: `${plan.label} prompt is too large for the Windows command line. Stage fewer changes and try again.`
        })
        return
      }
      child = input.spawnAgent({
        binary: plan.binary,
        args: plan.args,
        cwd,
        env: input.env,
        wslDistro: input.wslDistro,
        stdinMode: 'pipe',
        useCwdForNative: true
      })
    } catch (error) {
      markProcessClosed()
      if (error instanceof UnsafeWindowsBatchArgumentsError) {
        resolve({ success: false, error: userFacingUnsafeWindowsBatchArgs(plan.label) })
        return
      }
      console.error('[commit-message] Failed to spawn local generator:', error)
      resolve({
        success: false,
        error: `${plan.label} could not be started. Check the agent command in Settings and try again.`
      })
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
    let terminationComplete: Promise<void> | null = null
    let detachChildListeners = (): void => {}
    const startTermination = (): void => {
      terminationComplete ??= killSourceControlAgentProcess(child)
    }
    const markClosedAfterTermination = (): void => {
      void (terminationComplete ?? Promise.resolve()).then(markProcessClosed)
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
      if (!holdHomeLockUntilExit) {
        markProcessClosed()
      }
      resolve(value)
    }
    const cancel = (): void => {
      canceledByUser = true
      startTermination()
      finalize({ success: false, error: 'Generation canceled.', canceled: true })
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
      markClosedAfterTermination()
      if (canceledByUser) {
        finalize({ success: false, error: 'Generation canceled.', canceled: true })
        return
      }
      if (outputLimitExceeded) {
        finalize({
          success: false,
          error: `${plan.label} CLI command produced too much output. Check the agent CLI configuration and try again.`
        })
        return
      }
      finalize(
        finalizeFromAgentOutput({
          code,
          stdout,
          stderr,
          label: plan.label,
          emptyResultName: input.emptyResultName,
          includeStdoutDetail: operation !== 'branch-name'
        })
      )
    }
    child.stdout?.on('data', onStdoutData)
    child.stderr?.on('data', onStderrData)
    if (holdHomeLockUntilExit) {
      child.once('exit', markClosedAfterTermination)
      child.once('close', markClosedAfterTermination)
    }
    child.on('error', onError)
    child.on('close', onClose)
    detachChildListeners = () => {
      child.stdout?.off?.('data', onStdoutData)
      child.stderr?.off?.('data', onStderrData)
      child.off?.('error', onError)
      child.off?.('close', onClose)
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
