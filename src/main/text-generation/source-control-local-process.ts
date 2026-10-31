import { textGenerationFailure } from '../../shared/text-generation-failure-copy'
import { killSourceControlAgentProcess } from './source-control-agent-termination'
import { wslDistroForCommand } from '../../shared/wsl-paths'
import { prepareWslPrompt, stageLocalPromptFiles } from './source-control-prompt-files'
import { producePromptRecords } from './source-control-prompt-producer'
import { argumentBudgetFailure } from './source-control-command-line-budget'
export { fitsLocalCommandLine } from './source-control-command-line-budget'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import { WindowsCmdLineBreakError } from '@orca/process-host'
import { WindowsCommandLineBudgetError } from '../../shared/windows-command-line-budget'
import { supervisedProviderSpawnFailure } from '../provider-process/provider-spawn-failure-report'
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
  LocalSourceControlPlanInput
} from './source-control-text-generation-types'

export * from './source-control-agent-termination'

export function runLocalSourceControlPlan(
  input: LocalSourceControlPlanInput
): LocalProcessExecution<InternalTextGenerationResult> {
  let { plan } = input
  const { cwd, operation } = input
  const distro = plan.promptFile ? wslDistroForCommand(cwd, input.wslDistro) : null
  const guest = distro ? prepareWslPrompt(plan, distro) : undefined
  let closed = false
  let promptDirectory: string | undefined
  let markProcessClosed!: () => void
  const processClosed = new Promise<void>((resolve) => {
    markProcessClosed = () => {
      closed = true
      if (promptDirectory) {
        const directory = promptDirectory
        promptDirectory = undefined
        void removeTree(directory).catch((error: unknown) => {
          console.error('[commit-message] Failed to remove generation prompt:', error)
        })
      }
      resolve()
    }
  })
  const labelValue = { label: plan.label }
  const couldNotStart = textGenerationFailure('agentCouldNotStart', labelValue)
  const result = new Promise<InternalTextGenerationResult>((resolve) => {
    let child: SpawnedSourceControlAgentProcess
    try {
      plan =
        guest?.plan ??
        stageLocalPromptFiles(plan, (directory) => {
          promptDirectory = directory
        })
      // Reject oversized argv before opaque E2BIG spawn failure so users can act on the prompt-size limit.
      const budgetFailure = argumentBudgetFailure(plan)
      if (budgetFailure) {
        markProcessClosed()
        resolve({ success: false, ...budgetFailure })
        return
      }
      child = input.spawnAgent({
        binary: plan.binary,
        args: plan.args,
        cwd,
        env: input.env,
        commandEnv: plan.env,
        wslDistro: distro ?? input.wslDistro,
        ...(guest ? { preparation: guest.preparation } : {}),
        stdinMode: 'pipe',
        useCwdForNative: true
      })
    } catch (error) {
      markProcessClosed()
      if (error instanceof WindowsCommandLineBudgetError) {
        resolve({
          success: false,
          ...textGenerationFailure('promptTooLargeForWindows', labelValue)
        })
        return
      }
      if (error instanceof WindowsCmdLineBreakError) {
        resolve({ success: false, ...userFacingUnsafeWindowsBatchArgs(plan.label) })
        return
      }
      console.error('[commit-message] Failed to spawn local generator:', error)
      resolve({ success: false, ...couldNotStart })
      return
    }

    const stop = new AbortController()
    const deadline = Date.now() + SOURCE_CONTROL_GENERATION_TIMEOUT_MS
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
    const active = (): boolean =>
      !settled && !terminal && !stop.signal.aborted && Date.now() < deadline
    const startTermination = (): void => {
      stop.abort()
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
      stop.abort()
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
        ...textGenerationFailure('timedOut', {
          seconds: SOURCE_CONTROL_GENERATION_TIMEOUT_MS / 1000
        })
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
      if (settled) {
        return
      }
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
          ...textGenerationFailure('agentBinaryNotFound', {
            binary: plan.binary,
            label: plan.label
          })
        })
        return
      }
      console.error('[commit-message] Local generator failed after spawn:', error)
      finalize({ success: false, ...textGenerationFailure('agentFailedToStart', labelValue) })
    }
    const onClose = (code: number | null): void => {
      terminal = true
      stop.abort()
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
        finalize({ success: false, ...textGenerationFailure('outputTooLarge', labelValue) })
        return
      }
      const spawnFailure = supervisedProviderSpawnFailure(code, stderr)
      if (spawnFailure?.thrown) {
        console.error('[commit-message] Failed to spawn local generator:', spawnFailure.error)
        finalize({ success: false, ...couldNotStart })
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
          operation,
          includeStdoutDetail: operation !== 'branch-name' && operation !== 'conversation-name'
        })
      )
    }
    child.stdin?.on?.('error', (error: Error) => {
      if (active()) {
        startTermination()
        onError(error)
      }
    })
    child.stdin?.on?.('close', () => {
      if (guest && active() && !child.stdin?.writableEnded) {
        startTermination()
        onError(new Error('Generation input closed.'))
      }
    })
    child.stdout?.on('data', onStdoutData)
    if (guest) {
      child.stderr?.on('data', (chunk: Buffer) => {
        const proved = guest.observe(chunk, onStderrData)
        if (proved) {
          promptDirectory = guest.cleanupPath
          if (closed) {
            markProcessClosed()
          }
          if (active() && child.stdin) {
            void producePromptRecords(child.stdin, guest.records(), stop.signal, active).catch(
              (error: unknown) => {
                if (active()) {
                  startTermination()
                  onError(error instanceof Error ? error : new Error(String(error)))
                }
              }
            )
          }
        }
      })
    } else {
      child.stderr?.on('data', onStderrData)
    }
    child.on('error', onError)
    child.on('close', onClose)
    child.on('exit', () => {
      terminal = true
      stop.abort()
      markClosedAfterTermination()
    })
    detachChildListeners = () => {
      child.stdout?.off?.('data', onStdoutData)
      child.stderr?.off?.('data', onStderrData)
    }
    try {
      if (!guest) {
        child.stdin?.end(plan.stdinPayload ?? undefined)
      } else if (!child.stdin) {
        throw new Error('Generation input is unavailable.')
      }
    } catch (error) {
      startTermination()
      onError(error instanceof Error ? error : new Error(String(error)))
    }
  })
  return { result, processClosed }
}
