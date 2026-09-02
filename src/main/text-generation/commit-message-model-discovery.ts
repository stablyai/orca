import type { CommandTemplateBackslash } from '../../shared/commit-message-prompt'
import type { CommitMessagePlan } from '../../shared/commit-message-plan'
import { getAgentModelProbeSpec } from '../../shared/agent-model-probe-spec'
import type { TuiAgent } from '../../shared/tui-agent'
import { resolveCodexHomeProcessLockKeyForSpawnEnv } from '../codex-cli/codex-home-process-lock'
import { isSshMuxRequestTimeoutError } from '../ssh/ssh-channel-multiplexer'
import { WINDOWS_BATCH_UNSAFE_ARGUMENTS_ERROR } from '../win32-utils'
import {
  finalizeModelDiscoveryOutput,
  planModelDiscovery,
  staticModelDiscoveryResult
} from './commit-message-model-discovery-policy'
import { userFacingUnsafeWindowsBatchArgs } from './source-control-agent-failure'
import {
  MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES,
  SOURCE_CONTROL_GENERATION_TIMEOUT_MS
} from './source-control-generation-limits'
import { runCodexProcessWithHomeLock } from './source-control-local-generation'
import { killSourceControlAgentProcess } from './source-control-local-process'
import type {
  DiscoverCommitMessageModelsResult,
  LocalProcessExecution,
  RemoteCommitMessageExecResult,
  SpawnedSourceControlAgentProcess,
  SpawnSourceControlAgent
} from './source-control-text-generation-types'

export type CommitMessageModelDiscoveryLocalOptions = {
  cwd?: string
  wslDistro?: string
}

export async function discoverModelsLocal(input: {
  agentId: TuiAgent
  env: NodeJS.ProcessEnv | undefined
  agentCommandOverride?: string
  options: CommitMessageModelDiscoveryLocalOptions
  backslash: CommandTemplateBackslash
  spawnAgent: SpawnSourceControlAgent
}): Promise<DiscoverCommitMessageModelsResult> {
  const spec = getAgentModelProbeSpec(input.agentId)
  if (!spec) {
    return { success: false, error: `Agent "${input.agentId}" does not support model discovery.` }
  }
  if (spec.modelSource === 'static' || !spec.modelDiscovery) {
    return staticModelDiscoveryResult(spec)
  }

  const startDiscovery = (): LocalProcessExecution<DiscoverCommitMessageModelsResult> => {
    let markProcessClosed!: () => void
    const processClosed = new Promise<void>((resolve) => {
      markProcessClosed = resolve
    })
    const result = new Promise<DiscoverCommitMessageModelsResult>((resolve) => {
      let child: SpawnedSourceControlAgentProcess
      const planned = planModelDiscovery(spec, input.agentCommandOverride, input.backslash)
      if (!planned.ok) {
        markProcessClosed()
        resolve({ success: false, error: planned.error })
        return
      }
      try {
        child = input.spawnAgent({
          binary: planned.plan.binary,
          args: planned.plan.args,
          cwd: input.options.cwd,
          env: input.env,
          wslDistro: input.options.wslDistro,
          stdinMode: planned.plan.stdinPayload === null ? 'ignore' : 'pipe',
          useCwdForNative: false
        })
        if (planned.plan.stdinPayload !== null) {
          child.stdin?.on?.('error', () => {})
          child.stdin?.end(planned.plan.stdinPayload)
        }
      } catch (error) {
        markProcessClosed()
        console.error('[commit-message] Failed to spawn model discovery:', error)
        resolve({
          success: false,
          error: `${spec.label} model discovery could not be started. Check the agent CLI configuration and try again.`
        })
        return
      }

      let stdout = ''
      let stderr = ''
      let outputLimitExceeded = false
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      let terminationComplete: Promise<void> | null = null
      let detachChildListeners = (): void => {}
      const startTermination = (): void => {
        terminationComplete ??= killSourceControlAgentProcess(child)
      }
      const markClosedAfterTermination = (): void => {
        void (terminationComplete ?? Promise.resolve()).then(markProcessClosed)
      }
      const finish = (value: DiscoverCommitMessageModelsResult): void => {
        if (settled) {
          return
        }
        settled = true
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        detachChildListeners()
        if (input.agentId !== 'codex') {
          markProcessClosed()
        }
        resolve(value)
      }
      timer = setTimeout(() => {
        startTermination()
        finish({
          success: false,
          error: `${spec.label} model discovery timed out after ${SOURCE_CONTROL_GENERATION_TIMEOUT_MS / 1000}s.`
        })
      }, SOURCE_CONTROL_GENERATION_TIMEOUT_MS)

      const onData = (chunk: Buffer, append: (text: string) => void): void => {
        if (
          stdout.length + stderr.length + chunk.byteLength >
          MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES
        ) {
          outputLimitExceeded = true
          startTermination()
          finish({ success: false, error: `${spec.label} returned too much model data.` })
          return
        }
        append(chunk.toString('utf-8'))
      }
      const onStdoutData = (chunk: Buffer): void => onData(chunk, (text) => (stdout += text))
      const onStderrData = (chunk: Buffer): void => onData(chunk, (text) => (stderr += text))
      const onError = (error: Error): void => {
        if (!child.pid) {
          markProcessClosed()
        }
        finish({
          success: false,
          error:
            (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? `${spec.modelDiscovery?.binary ?? spec.binary} not found on PATH. Install ${spec.label} to discover models.`
              : `${spec.label} model discovery failed to start. Check the agent CLI configuration and try again.`
        })
      }
      const onClose = (code: number | null): void => {
        markClosedAfterTermination()
        finish(
          outputLimitExceeded
            ? { success: false, error: `${spec.label} returned too much model data.` }
            : finalizeModelDiscoveryOutput(spec, stdout, stderr, code)
        )
      }
      child.stdout?.on('data', onStdoutData)
      child.stderr?.on('data', onStderrData)
      if (input.agentId === 'codex') {
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
    })
    return { result, processClosed }
  }
  return input.agentId === 'codex'
    ? runCodexProcessWithHomeLock(
        resolveCodexHomeProcessLockKeyForSpawnEnv(input.env, input.options.wslDistro),
        startDiscovery
      )
    : startDiscovery().result
}

export async function discoverModelsRemote(input: {
  agentId: TuiAgent
  cwd: string
  execute: (
    plan: CommitMessagePlan,
    cwd: string,
    timeoutMs: number
  ) => Promise<RemoteCommitMessageExecResult>
  agentCommandOverride?: string
}): Promise<DiscoverCommitMessageModelsResult> {
  const spec = getAgentModelProbeSpec(input.agentId)
  if (!spec) {
    return { success: false, error: `Agent "${input.agentId}" does not support model discovery.` }
  }
  if (spec.modelSource === 'static' || !spec.modelDiscovery) {
    return staticModelDiscoveryResult(spec)
  }
  const planned = planModelDiscovery(spec, input.agentCommandOverride)
  if (!planned.ok) {
    return { success: false, error: planned.error }
  }
  let result: RemoteCommitMessageExecResult
  try {
    result = await input.execute(planned.plan, input.cwd, SOURCE_CONTROL_GENERATION_TIMEOUT_MS)
  } catch (error) {
    console.error('[commit-message] Remote model discovery request failed:', error)
    return {
      success: false,
      error: isSshMuxRequestTimeoutError(error)
        ? `${spec.label} model discovery took longer than ${SOURCE_CONTROL_GENERATION_TIMEOUT_MS / 1000}s and may still be running on the remote host.`
        : `${spec.label} model discovery could not be reached on the remote PATH. Try again after the SSH connection recovers.`
    }
  }
  if (result.spawnError) {
    if (result.spawnError === WINDOWS_BATCH_UNSAFE_ARGUMENTS_ERROR) {
      return { success: false, error: userFacingUnsafeWindowsBatchArgs(spec.label) }
    }
    if (/ENOENT/i.test(result.spawnError)) {
      return {
        success: false,
        error: `${planned.plan.binary} not found on the remote PATH. Install ${spec.label} there.`
      }
    }
    console.error('[commit-message] Remote model discovery spawn failed:', result.spawnError)
    return {
      success: false,
      error: `${spec.label} model discovery could not be started on the remote PATH. Check the agent command there and try again.`
    }
  }
  if (result.canceled) {
    return { success: false, error: 'Model discovery canceled.' }
  }
  if (result.timedOut) {
    return {
      success: false,
      error: `${spec.label} model discovery timed out after ${SOURCE_CONTROL_GENERATION_TIMEOUT_MS / 1000}s.`
    }
  }
  return finalizeModelDiscoveryOutput(spec, result.stdout, result.stderr, result.exitCode)
}
