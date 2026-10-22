import { isMissingProviderExecutable } from '../provider-process/provider-executable-missing'
import { mergeCommandEnvironment } from '../../shared/command-environment'
import type { CommandTemplateBackslash } from '../../shared/commit-message-prompt'
import {
  getAgentModelProbeSpec,
  type AgentModelProbeSpec
} from '../../shared/agent-model-probe-spec'
import type { CommitMessagePlan } from '../../shared/commit-message-plan'
import {
  runClaudeBackgroundAttempts,
  type ClaudeBackgroundFailedExit
} from '../../shared/claude-background-run-isolation'
import type { TuiAgent } from '../../shared/tui-agent'
import { resolveCodexHomeProcessLockKeyForSpawnEnv } from '../codex-cli/codex-home-process-lock'
import { supervisedProviderSpawnFailure } from '../provider-process/provider-spawn-failure-report'
import {
  finalizeModelDiscoveryOutput,
  planModelDiscovery,
  staticModelDiscoveryResult
} from './commit-message-model-discovery-policy'
import {
  MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES,
  SOURCE_CONTROL_GENERATION_TIMEOUT_MS
} from './source-control-generation-limits'
import { runCodexProcessWithHomeLock } from './source-control-local-generation'
import { killSourceControlAgentProcess } from './source-control-local-process'
import type {
  DiscoverCommitMessageModelsResult,
  LocalProcessExecution,
  SpawnedSourceControlAgentProcess,
  SpawnSourceControlAgent
} from './source-control-text-generation-types'

export type CommitMessageModelDiscoveryLocalOptions = {
  cwd?: string
  wslDistro?: string
}

type DiscoverModelsLocalInput = {
  agentId: TuiAgent
  env: NodeJS.ProcessEnv | undefined
  agentCommandOverride?: string
  options: CommitMessageModelDiscoveryLocalOptions
  backslash: CommandTemplateBackslash
  spawnAgent: SpawnSourceControlAgent
  /** The command actually spawned, when the caller replaces the plan's; a missing one is typed. */
  binary?: string
}

export async function discoverModelsLocal(
  input: DiscoverModelsLocalInput
): Promise<DiscoverCommitMessageModelsResult> {
  const spec = getAgentModelProbeSpec(input.agentId)
  if (!spec) {
    return { success: false, error: `Agent "${input.agentId}" does not support model discovery.` }
  }
  if (spec.modelSource === 'static' || !spec.modelDiscovery) {
    return staticModelDiscoveryResult(spec)
  }

  const planned = planModelDiscovery(spec, input.agentCommandOverride, input.backslash)
  if (!planned.ok) {
    return { success: false, error: planned.error }
  }
  const env = mergeCommandEnvironment(
    input.env,
    planned.plan.env,
    input.options.wslDistro ? 'linux' : process.platform
  )
  const attempt = await runClaudeBackgroundAttempts({
    agentId: input.agentId,
    run: (strictMcp): ReturnType<typeof discoverModelsOnce> => {
      const rebuilt = strictMcp
        ? planned
        : planModelDiscovery(spec, input.agentCommandOverride, input.backslash, strictMcp)
      return rebuilt.ok
        ? discoverModelsOnce(input, spec, rebuilt.plan, env)
        : Promise.resolve({ result: { success: false as const, error: rebuilt.error } })
    },
    failedExit: (outcome) => (outcome.result.success ? undefined : outcome.failedExit)
  })
  return attempt.result
}

async function discoverModelsOnce(
  input: DiscoverModelsLocalInput,
  spec: AgentModelProbeSpec,
  plan: CommitMessagePlan,
  env: NodeJS.ProcessEnv | undefined
): Promise<{ result: DiscoverCommitMessageModelsResult; failedExit?: ClaudeBackgroundFailedExit }> {
  let failedExit: ClaudeBackgroundFailedExit | undefined

  const binary = input.binary ?? plan.binary
  const couldNotStart = `${spec.label} model discovery could not be started. Check the agent CLI configuration and try again.`
  const startFailure = (error: unknown): DiscoverCommitMessageModelsResult => ({
    success: false,
    ...(isMissingProviderExecutable(error, binary)
      ? { unavailable: { reason: 'cliMissing' as const } }
      : {}),
    error: couldNotStart
  })
  const startDiscovery = (): LocalProcessExecution<DiscoverCommitMessageModelsResult> => {
    let markProcessClosed!: () => void
    const processClosed = new Promise<void>((resolve) => {
      markProcessClosed = resolve
    })
    const result = new Promise<DiscoverCommitMessageModelsResult>((resolve) => {
      let child: SpawnedSourceControlAgentProcess
      try {
        child = input.spawnAgent({
          binary,
          args: plan.args,
          cwd: input.options.cwd,
          env: input.options.wslDistro ? input.env : env,
          commandEnv: plan.env,
          wslDistro: input.options.wslDistro,
          stdinMode: plan.stdinPayload === null ? 'ignore' : 'pipe',
          useCwdForNative: false
        })
        if (plan.stdinPayload !== null) {
          child.stdin?.on?.('error', () => {})
          child.stdin?.end(plan.stdinPayload)
        }
      } catch (error) {
        markProcessClosed()
        console.error('[commit-message] Failed to spawn model discovery:', error)
        resolve(startFailure(error))
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
          ...(isMissingProviderExecutable(error, binary)
            ? { unavailable: { reason: 'cliMissing' as const } }
            : {}),
          error:
            (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? `${spec.modelDiscovery?.binary ?? spec.binary} not found on PATH. Install ${spec.label} to discover models.`
              : `${spec.label} model discovery failed to start. Check the agent CLI configuration and try again.`
        })
      }
      const onClose = (code: number | null): void => {
        markClosedAfterTermination()
        // A supervised spawn failure reads as the same failure a direct spawn reports.
        const spawnFailure = outputLimitExceeded
          ? null
          : supervisedProviderSpawnFailure(code, stderr)
        if (spawnFailure?.thrown) {
          console.error('[commit-message] Failed to spawn model discovery:', spawnFailure.error)
          finish(startFailure(spawnFailure.error))
          return
        }
        if (spawnFailure) {
          onError(spawnFailure.error)
          return
        }
        if (!settled && !outputLimitExceeded) {
          failedExit = { exitCode: code, stdout, stderr }
        }
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
  const result = await (input.agentId === 'codex'
    ? runCodexProcessWithHomeLock(
        resolveCodexHomeProcessLockKeyForSpawnEnv(env, input.options.wslDistro, plan.env),
        startDiscovery
      )
    : startDiscovery().result)
  return { result, failedExit }
}
