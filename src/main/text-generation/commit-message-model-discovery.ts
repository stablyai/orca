import { isMissingProviderExecutable } from '../provider-process/provider-executable-missing'
import { mergeCommandEnvironment } from '../../shared/command-environment'
import type { CommandTemplateBackslash } from '../../shared/source-control/ai/generation/commit-message-prompt'
import {
  getAgentModelProbeSpec,
  type AgentModelProbeSpec
} from '../../shared/agent-model-probe-spec'
import type { CommitMessagePlan } from '../../shared/source-control/ai/generation/commit-message-plan'
import {
  runClaudeBackgroundAttempts,
  type ClaudeBackgroundFailedExit
} from '../../shared/claude-background-run-isolation'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import { resolveCodexHomeProcessLockKeyForSpawnEnv } from '../codex-cli/codex-home-process-lock'
import { supervisedProviderSpawnFailure } from '../provider-process/provider-spawn-failure-report'
import {
  discoveredModelsResult,
  finalizeModelDiscoveryOutput,
  planModelDiscovery,
  staticModelDiscoveryResult
} from './commit-message-model-discovery-policy'
import {
  MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES,
  SOURCE_CONTROL_GENERATION_TIMEOUT_MS
} from './source-control-generation-limits'
import { runCodexProcessWithHomeLock } from './source-control-local-generation'
import { formatAgentCliFailureMessage } from './source-control-agent-failure'
import {
  startCodexModelListDiscovery,
  type CodexModelListDiscovery
} from './codex-model-list-discovery'
import { killSourceControlAgentProcess } from './source-control-local-process'
import type {
  DiscoverCommitMessageModelsResult,
  LocalProcessExecution,
  SpawnedSourceControlAgentProcess,
  SpawnSourceControlAgent
} from './source-control-text-generation-types'

const APP_SERVER_EXIT_GRACE_MS = 1_500

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
  /** Actual spawned command when it differs from the plan; missing binaries return a typed failure. */
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
  // The app-server answers `model/list` over the stdin it must keep open.
  const appServer = spec.modelDiscovery !== undefined && 'listing' in spec.modelDiscovery
  const startDiscovery = (): LocalProcessExecution<DiscoverCommitMessageModelsResult> => {
    let markProcessClosed!: () => void
    const processClosed = new Promise<void>((resolve) => {
      markProcessClosed = resolve
    })
    const result = new Promise<DiscoverCommitMessageModelsResult>((resolve) => {
      let child: SpawnedSourceControlAgentProcess
      let listing: CodexModelListDiscovery | null = null
      try {
        child = input.spawnAgent({
          binary,
          args: plan.args,
          cwd: input.options.cwd,
          env: input.options.wslDistro ? input.env : env,
          commandEnv: plan.env,
          wslDistro: input.options.wslDistro,
          stdinMode: plan.stdinPayload === null && !appServer ? 'ignore' : 'pipe',
          useCwdForNative: false
        })
        if (appServer && child.stdin) {
          const stdin = child.stdin
          listing = startCodexModelListDiscovery(stdin)
          stdin.on('error', (error) => listing?.fail(error))
        } else if (plan.stdinPayload !== null) {
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
      // Listed output is framed, not kept, so its budget counts what was read.
      let listedBytes = 0
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
          stdout.length + listedBytes + stderr.length + chunk.byteLength >
          MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES
        ) {
          outputLimitExceeded = true
          startTermination()
          finish({ success: false, error: `${spec.label} returned too much model data.` })
          return
        }
        append(chunk.toString('utf-8'))
      }
      const onStdoutData = (chunk: Buffer): void =>
        listing
          ? onData(chunk, () => {
              listedBytes += chunk.byteLength
              listing?.receive(chunk)
            })
          : onData(chunk, (text) => (stdout += text))
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
        listing?.fail(new Error(`${spec.label} app-server exited`))
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
            : listing
              ? listingFailure(code)
              : finalizeModelDiscoveryOutput(spec, stdout, stderr, code)
        )
      }
      const listingFailure = (code: number | null): DiscoverCommitMessageModelsResult => {
        console.error('[commit-message] Model discovery failed:', {
          label: spec.label,
          exitCode: code,
          stderr
        })
        return {
          success: false,
          error: formatAgentCliFailureMessage(spec.label, '', stderr, code)
        }
      }
      // A served listing ends the app-server, which would otherwise wait on stdin forever. Codex
      // rewrites its shared models cache at startup, so stdin EOF gets a grace before any kill.
      const endAppServer = (): void => {
        try {
          child.stdin?.end()
        } catch {
          // A destroyed stdin still leaves the kill below.
        }
        const grace = setTimeout(startTermination, APP_SERVER_EXIT_GRACE_MS)
        child.once('exit', () => clearTimeout(grace))
      }
      void listing?.models.then(
        (models) => {
          if (settled) {
            return
          }
          endAppServer()
          finish(
            models
              ? discoveredModelsResult(spec, models)
              : { success: false, error: `${spec.label} returned no available models.` }
          )
        },
        (error: unknown) => {
          if (settled) {
            return
          }
          endAppServer()
          console.error('[commit-message] Model discovery failed:', error)
          finish({
            success: false,
            error: `${spec.label} model discovery failed. Check the agent CLI configuration and try again.`
          })
        }
      )
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
