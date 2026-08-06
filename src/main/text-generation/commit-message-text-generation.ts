/* eslint-disable max-lines -- Why: local and SSH generation share cancellation,
   spawn failure handling, and output normalization; keeping them together
   prevents those paths from drifting. */
import { spawn, type ChildProcess } from 'node:child_process'
import type { GlobalSettings, Repo, TuiAgent } from '../../shared/types'
import {
  buildCommitMessagePrompt,
  splitGeneratedCommitMessage,
  type CommitMessageDraftContext,
  type GeneratedCommitMessage
} from '../../shared/commit-message-generation'
import {
  buildPullRequestFieldsPrompt,
  parseGeneratedPullRequestFields,
  type GeneratedPullRequestFields,
  type PullRequestDraftContext
} from '../../shared/pull-request-generation'
import {
  cleanGeneratedCommitMessage,
  excerptAgentFailureOutput
} from '../../shared/commit-message-prompt'
import {
  captureAgentGenerationFailureOutput,
  type AgentGenerationFailureOutput
} from './agent-failure-output'
import {
  buildBranchNamePrompt,
  sanitizeBranchSlug,
  type BranchNameWorkContext
} from '../../shared/branch-name-from-work'
import {
  getCommitMessageAgentSpec,
  type CommitMessageAgentCapability,
  type CommitMessageModelCapability
} from '../../shared/commit-message-agent-spec'
import {
  planAgentBinary,
  planCommitMessageGeneration,
  type CommitMessagePlan
} from '../../shared/commit-message-plan'
import { LOCAL_COMMIT_MESSAGE_HOST_KEY } from '../../shared/commit-message-host-key'
import {
  resolveSourceControlAiForOperation,
  type ResolvedSourceControlAiGenerationParams
} from '../../shared/source-control-ai'
import type { SourceControlAiOperation } from '../../shared/source-control-ai-types'
import { formatLinkedIssueTemplateValue } from '../../shared/source-control-ai-action-variables'
import { renderSourceControlActionCommandTemplate } from '../../shared/source-control-ai-actions'
import { resolveCliCommand } from '../codex-cli/command'
import {
  resolveCodexHomeProcessLockKeyForSpawnEnv,
  withCodexHomeProcessLock
} from '../codex-cli/codex-home-process-lock'
import {
  getSpawnArgsForWindows,
  UnsafeWindowsBatchArgumentsError,
  WINDOWS_BATCH_UNSAFE_ARGUMENTS_ERROR
} from '../win32-utils'
import { withMacTailscaleDnsHint } from '../network/macos-tailscale-dns-diagnostic'
import { wslAwareSpawn } from '../git/runner'
import { terminateWindowsProcessTree } from '../windows-process-tree-kill'
import { isSshMuxRequestTimeoutError } from '../ssh/ssh-channel-multiplexer'

const GENERATION_TIMEOUT_MS = 60_000
const MAX_AGENT_OUTPUT_BYTES = 4 * 1024 * 1024

export type GenerateCommitMessageParams = ResolvedSourceControlAiGenerationParams

export type GenerateCommitMessageResult =
  | { success: true; message: string; agentLabel?: string }
  | { success: false; error: string; canceled?: boolean }

export type DiscoverCommitMessageModelsResult =
  | {
      success: true
      capability: CommitMessageAgentCapability
      models: CommitMessageModelCapability[]
      defaultModelId: string
      catalogOrigin: 'probe' | 'spec'
    }
  | { success: false; error: string }

export type GeneratePullRequestFieldsResult =
  | {
      success: true
      fields: GeneratedPullRequestFields
      agentLabel?: string
      branchChangedByPreparation?: boolean
    }
  | { success: false; error: string; canceled?: boolean; branchChangedByPreparation?: boolean }

export type RemoteCommitMessageExecResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  canceled?: boolean
  spawnError?: string
}

export type TextGenerationOperation = 'commit-message' | 'pull-request-fields' | 'branch-name'

export type CommitMessageGenerationTarget =
  | { kind: 'local'; cwd: string; env?: NodeJS.ProcessEnv; wslDistro?: string }
  | {
      kind: 'remote'
      cwd: string
      execute: (
        plan: CommitMessagePlan,
        cwd: string,
        timeoutMs: number,
        operation: TextGenerationOperation
      ) => Promise<RemoteCommitMessageExecResult>
      missingBinaryLocation: string
    }

type ResolveCommitMessageSettingsResult =
  | { ok: true; params: GenerateCommitMessageParams }
  | { ok: false; error: string }

type InternalTextGenerationResult =
  | { success: true; rawOutput: string; agentLabel?: string }
  | {
      success: false
      error: string
      canceled?: boolean
      /** Bounded full CLI output for on-demand local display. Stripped from
       *  every renderer-bound result so it never crosses IPC wholesale. */
      failureOutput?: AgentGenerationFailureOutput
    }

type LocalProcessExecution<T> = {
  result: Promise<T>
  processClosed: Promise<void>
}

export type CommitMessageModelDiscoveryLocalOptions = {
  cwd?: string
  wslDistro?: string
}

export function trimGeneratedCommitMessage(message: string): string {
  return message.replace(/\s+$/, '')
}

export function resolveCommitMessageSettings(
  settings: GlobalSettings,
  discoveryHostKey = LOCAL_COMMIT_MESSAGE_HOST_KEY,
  operation: SourceControlAiOperation = 'commitMessage',
  repo?: Pick<Repo, 'sourceControlAi'> | null
): ResolveCommitMessageSettingsResult {
  const resolved = resolveSourceControlAiForOperation({
    settings,
    repo,
    operation,
    discoveryHostKey
  })
  return resolved.ok ? { ok: true, params: resolved.value.params } : resolved
}

export function resolveTextGenerationParams(
  settings: GlobalSettings,
  discoveryHostKey = LOCAL_COMMIT_MESSAGE_HOST_KEY,
  operation: SourceControlAiOperation = 'commitMessage',
  repo?: Pick<Repo, 'sourceControlAi'> | null
): ResolveCommitMessageSettingsResult {
  return resolveCommitMessageSettings(settings, discoveryHostKey, operation, repo)
}

function formatAgentCliFailureMessage(
  label: string,
  stdout: string,
  stderr: string,
  exitCode: number | null,
  options?: { includeLocalMacDnsHint?: boolean; includeStdoutDetail?: boolean }
): string {
  const detail = sanitizeAgentFailureDetail(
    excerptAgentFailureOutput(options?.includeStdoutDetail === false ? '' : stdout, stderr)
  )
  const message =
    exitCode === null
      ? detail
        ? `${label} CLI command was terminated before exiting: ${detail}`
        : `${label} CLI command was terminated before exiting.`
      : detail
        ? `${label} CLI command failed with code ${exitCode}: ${detail}`
        : `${label} CLI command failed with code ${exitCode}.`
  return options?.includeLocalMacDnsHint === false
    ? message
    : withMacTailscaleDnsHint(message, detail)
}

function sanitizeAgentFailureDetail(detail: string | null): string | null {
  // Cf covers bidi overrides (U+202E etc.) that could visually reorder the
  // persisted, client-synced detail.
  const trimmed = detail
    ?.replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!trimmed) {
    return null
  }
  // Why: agent stderr often includes local or SSH repo paths. Persisting those
  // into worktree metadata leaks environment details into synced renderer state.
  const redacted = trimmed
    .replace(
      /\\\\[^\s"'`<>\\]+\\(?:[^\s"'`<>\\]+(?:\s+[^\s"'`<>\\]+)*(?=\\)\\)*[^\s"'`<>\\]+/g,
      '[path]'
    )
    // Only backslashes may repeat: JSON provider bodies double them
    // (`C:\\Users\\name\\…`), while a URL's `://` must stay single so remedy
    // links like `https://…` survive redaction.
    .replace(
      /[A-Za-z]:(?:\\+|\/)(?:[^\s"'`<>\\/|:*?]+(?:\s+[^\s"'`<>\\/|:*?]+)*(?=[\\/])(?:\\+|\/))*[^\s"'`<>\\/|:*?]+/g,
      '[path]'
    )
    // Why: require ≥2 segments (one internal `/`) so provider remedy tokens like
    // `/login` survive while multi-segment paths (`/Users/name/repo`) still redact.
    // `=:,` prefixes catch key=/path value:/path list,/path shapes in provider bodies.
    .replace(
      /(^|[\s"'`(=:,])\/(?:[^\s"'`<>/]+(?:\s+[^\s"'`<>/]+)*(?=\/)\/)+[^\s"'`<>/]+/g,
      '$1[path]'
    )
  return redacted.length > 240 ? `${redacted.slice(0, 240).trimEnd()}...` : redacted
}

function userFacingUnsafeWindowsBatchArgs(label: string): string {
  return `${label} cannot be run as a Windows batch command with the prompt in argv. Remove {prompt} so Orca sends the prompt on stdin.`
}

function toModelDiscoveryCapability(
  spec: NonNullable<ReturnType<typeof getCommitMessageAgentSpec>>,
  models = spec.models,
  defaultModelId = spec.defaultModelId,
  catalogOrigin: 'probe' | 'spec' = 'spec'
): Extract<DiscoverCommitMessageModelsResult, { success: true }> {
  return {
    success: true,
    capability: {
      id: spec.id,
      label: spec.label,
      modelSource: spec.modelSource,
      defaultModelId,
      models
    },
    models,
    defaultModelId,
    catalogOrigin
  }
}

function finalizeModelDiscoveryOutput(
  spec: NonNullable<ReturnType<typeof getCommitMessageAgentSpec>>,
  stdout: string,
  stderr: string,
  code: number | null
): DiscoverCommitMessageModelsResult {
  if (code !== 0) {
    console.error('[commit-message] Model discovery failed:', {
      label: spec.label,
      exitCode: code,
      stdout,
      stderr
    })
    return {
      success: false,
      error: formatAgentCliFailureMessage(spec.label, stdout, stderr, code)
    }
  }
  let models = spec.modelDiscovery?.parse(stdout) ?? []
  if (models.length === 0 && stderr.trim()) {
    // Why: Pi currently writes its successful `--list-models` table to stderr,
    // so exit code 0 must still allow stderr-backed discovery.
    models = spec.modelDiscovery?.parse(stderr) ?? []
  }
  if (models.length === 0) {
    if (spec.models.length > 0) {
      console.warn('[commit-message] Model discovery returned no models; using static fallback:', {
        label: spec.label
      })
      return toModelDiscoveryCapability(spec, spec.models, spec.defaultModelId)
    }
    return { success: false, error: `${spec.label} returned no available models.` }
  }
  const defaultModelId = models.some((model) => model.id === spec.defaultModelId)
    ? spec.defaultModelId
    : models[0].id
  return toModelDiscoveryCapability(spec, models, defaultModelId, 'probe')
}

function planModelDiscovery(
  spec: NonNullable<ReturnType<typeof getCommitMessageAgentSpec>>,
  agentCommandOverride?: string
): { ok: true; plan: CommitMessagePlan } | { ok: false; error: string } {
  const modelDiscovery = spec.modelDiscovery
  if (!modelDiscovery) {
    return { ok: false, error: `${spec.label} does not support dynamic model discovery.` }
  }
  const command = planAgentBinary(modelDiscovery.binary, agentCommandOverride)
  if (!command.ok) {
    return command
  }
  return {
    ok: true,
    plan: {
      binary: command.binary,
      args: [...command.prefixArgs, ...modelDiscovery.args],
      stdinPayload: modelDiscovery.stdinPayload ?? null,
      label: spec.label
    }
  }
}

export async function discoverCommitMessageModelsLocal(
  agentId: TuiAgent,
  env: NodeJS.ProcessEnv | undefined,
  agentCommandOverride?: string,
  options: CommitMessageModelDiscoveryLocalOptions = {}
): Promise<DiscoverCommitMessageModelsResult> {
  const spec = getCommitMessageAgentSpec(agentId)
  if (!spec) {
    return { success: false, error: `Agent "${agentId}" does not support AI commit messages.` }
  }

  if (spec.modelSource === 'static' || !spec.modelDiscovery) {
    return toModelDiscoveryCapability(spec)
  }

  const startDiscovery = (): LocalProcessExecution<DiscoverCommitMessageModelsResult> => {
    let markProcessClosed!: () => void
    const processClosed = new Promise<void>((resolve) => {
      markProcessClosed = resolve
    })
    const result = new Promise<DiscoverCommitMessageModelsResult>((resolve) => {
      let child: ChildProcess
      const spawnEnv = env ?? process.env
      let discoveryStdin: string | null = null
      try {
        const planned = planModelDiscovery(spec, agentCommandOverride)
        if (!planned.ok) {
          markProcessClosed()
          resolve({ success: false, error: planned.error })
          return
        }
        discoveryStdin = planned.plan.stdinPayload
        const stdinMode = discoveryStdin === null ? 'ignore' : 'pipe'
        if (process.platform === 'win32' && options.wslDistro) {
          child = wslAwareSpawn(planned.plan.binary, planned.plan.args, {
            cwd: options.cwd,
            env: buildWslLauncherEnv(env),
            stdio: [stdinMode, 'pipe', 'pipe'],
            windowsHide: true,
            wslDistro: options.wslDistro,
            useWslLoginShell: true
          })
        } else {
          const resolvedBinary =
            process.platform === 'win32'
              ? resolveCliCommand(planned.plan.binary, {
                  pathEnv: spawnEnv.PATH ?? spawnEnv.Path ?? null
                })
              : planned.plan.binary
          const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(resolvedBinary, planned.plan.args)
          child = spawn(spawnCmd, spawnArgs, {
            env: spawnEnv,
            stdio: [stdinMode, 'pipe', 'pipe'],
            windowsHide: true
          })
        }
        if (discoveryStdin !== null) {
          // Why: a CLI that rejects the args exits before reading stdin; the
          // resulting EPIPE must surface as exit-code fallback, not a crash.
          child.stdin?.on?.('error', () => {})
          child.stdin?.end(discoveryStdin)
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
        terminationComplete ??= killProcessTree(child)
      }
      const markClosedAfterTermination = (): void => {
        void (terminationComplete ?? Promise.resolve()).then(markProcessClosed)
      }
      const finish = (result: DiscoverCommitMessageModelsResult): void => {
        if (settled) {
          return
        }
        settled = true
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        detachChildListeners()
        if (agentId !== 'codex') {
          markProcessClosed()
        }
        resolve(result)
      }
      timer = setTimeout(() => {
        startTermination()
        finish({
          success: false,
          error: `${spec.label} model discovery timed out after ${GENERATION_TIMEOUT_MS / 1000}s.`
        })
      }, GENERATION_TIMEOUT_MS)

      const onData = (chunk: Buffer, append: (text: string) => void): void => {
        if (stdout.length + stderr.length + chunk.byteLength > MAX_AGENT_OUTPUT_BYTES) {
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
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          finish({
            success: false,
            error: `${spec.modelDiscovery?.binary ?? spec.binary} not found on PATH. Install ${spec.label} to discover models.`
          })
          return
        }
        finish({
          success: false,
          error: `${spec.label} model discovery failed to start. Check the agent CLI configuration and try again.`
        })
      }
      const onClose = (code: number | null): void => {
        markClosedAfterTermination()
        if (outputLimitExceeded) {
          finish({ success: false, error: `${spec.label} returned too much model data.` })
          return
        }
        if (code !== 0) {
          finish(finalizeModelDiscoveryOutput(spec, stdout, stderr, code))
          return
        }
        finish(finalizeModelDiscoveryOutput(spec, stdout, stderr, code))
      }

      child.stdout?.on('data', onStdoutData)
      child.stderr?.on('data', onStderrData)
      if (agentId === 'codex') {
        // Result publication stays prompt while the home lock follows the
        // process lifetime after asynchronous timeout/output-limit kills.
        // Why: 'close' also waits on descendants that inherited this child's
        // stdio, so a surviving MCP helper would hold the home forever; at
        // 'exit' the codex process is gone and can no longer rotate auth.json.
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

  if (agentId === 'codex') {
    // Why: discovery spawns a real codex process in the selected home; keep it
    // off an auth.json a quota probe may be refreshing at the same time.
    return runCodexProcessWithHomeLock(
      resolveCodexHomeProcessLockKeyForSpawnEnv(env, options.wslDistro),
      startDiscovery
    )
  }
  return startDiscovery().result
}

export async function discoverCommitMessageModelsRemote(
  agentId: TuiAgent,
  cwd: string,
  execute: (
    plan: CommitMessagePlan,
    cwd: string,
    timeoutMs: number
  ) => Promise<RemoteCommitMessageExecResult>,
  agentCommandOverride?: string
): Promise<DiscoverCommitMessageModelsResult> {
  const spec = getCommitMessageAgentSpec(agentId)
  if (!spec) {
    return { success: false, error: `Agent "${agentId}" does not support AI commit messages.` }
  }
  if (spec.modelSource === 'static' || !spec.modelDiscovery) {
    return toModelDiscoveryCapability(spec)
  }
  const planned = planModelDiscovery(spec, agentCommandOverride)
  if (!planned.ok) {
    return { success: false, error: planned.error }
  }
  let result: RemoteCommitMessageExecResult
  try {
    result = await execute(planned.plan, cwd, GENERATION_TIMEOUT_MS)
  } catch (error) {
    console.error('[commit-message] Remote model discovery request failed:', error)
    if (isSshMuxRequestTimeoutError(error)) {
      return {
        success: false,
        error: `${spec.label} model discovery took longer than ${GENERATION_TIMEOUT_MS / 1000}s and may still be running on the remote host.`
      }
    }
    return {
      success: false,
      error: `${spec.label} model discovery could not be reached on the remote PATH. Try again after the SSH connection recovers.`
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
      error: `${spec.label} model discovery timed out after ${GENERATION_TIMEOUT_MS / 1000}s.`
    }
  }
  return finalizeModelDiscoveryOutput(spec, result.stdout, result.stderr, result.exitCode)
}

// Why: on Windows, npm-installed CLIs like `claude` and `codex` are usually
// `.cmd` shims. We route those through cmd.exe so Node can launch them, and
// `child.kill()` would only terminate the wrapper. `taskkill /T /F` walks the
// process tree from the wrapper PID and force-kills every descendant, which is
// what users expect when they hit "stop generating".
function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (!pid) {
    return Promise.resolve()
  }
  if (process.platform === 'win32') {
    return terminateWindowsProcessTree(pid)
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // The child may have already exited between the in-flight check and the
    // kill - that race is benign and can be ignored.
  }
  return Promise.resolve()
}

// Keying by operation plus `local:${cwd}` keeps local cancellation independent
// from SSH worktrees and from other generation features in the same worktree.
const cancelTokensByLane = new Map<string, () => void>()
const WSL_LAUNCHER_ENV_KEYS = [
  'ComSpec',
  'COMSPEC',
  'Path',
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'WINDIR'
] as const

function localLaneKey(operation: TextGenerationOperation, cwd: string): string {
  return `${operation}:local:${cwd}`
}

export function cancelGenerateCommitMessageLocal(cwd: string): void {
  cancelTokensByLane.get(localLaneKey('commit-message', cwd))?.()
}

function buildWslLauncherEnv(explicitEnv: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of WSL_LAUNCHER_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) {
      env[key] = value
    }
  }
  for (const [key, value] of Object.entries(explicitEnv ?? {})) {
    if (value !== undefined && value !== process.env[key]) {
      env[key] = value
    }
  }
  return env
}

function runLocalPlan(
  plan: CommitMessagePlan,
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  emptyResultName = 'message',
  operation: TextGenerationOperation = 'commit-message',
  wslDistro?: string,
  holdHomeLockUntilExit = false
): LocalProcessExecution<InternalTextGenerationResult> {
  const { binary, args, stdinPayload, label } = plan
  let markProcessClosed!: () => void
  const processClosed = new Promise<void>((resolve) => {
    markProcessClosed = resolve
  })
  const result = new Promise<InternalTextGenerationResult>((resolve) => {
    let child: ChildProcess
    try {
      const spawnEnv = env ?? process.env
      if (process.platform === 'win32' && wslDistro) {
        child = wslAwareSpawn(binary, args, {
          cwd,
          env: buildWslLauncherEnv(env),
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          wslDistro,
          useWslLoginShell: true
        })
      } else {
        const resolvedBinary =
          process.platform === 'win32'
            ? resolveCliCommand(binary, { pathEnv: spawnEnv.PATH ?? spawnEnv.Path ?? null })
            : binary
        const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(resolvedBinary, args)
        child = spawn(spawnCmd, spawnArgs, {
          cwd,
          env: spawnEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        })
      }
    } catch (error) {
      markProcessClosed()
      if (error instanceof UnsafeWindowsBatchArgumentsError) {
        resolve({
          success: false,
          error: userFacingUnsafeWindowsBatchArgs(label)
        })
        return
      }
      console.error('[commit-message] Failed to spawn local generator:', error)
      resolve({
        success: false,
        error: `${label} could not be started. Check the agent command in Settings and try again.`
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
    const laneKey = localLaneKey(operation, cwd)
    let cancelToken: (() => void) | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let terminationComplete: Promise<void> | null = null
    let detachChildListeners = (): void => {}
    const startTermination = (): void => {
      terminationComplete ??= killProcessTree(child)
    }
    const markClosedAfterTermination = (): void => {
      void (terminationComplete ?? Promise.resolve()).then(markProcessClosed)
    }
    const finalize = (result: InternalTextGenerationResult): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      detachChildListeners()
      if (cancelToken && cancelTokensByLane.get(laneKey) === cancelToken) {
        cancelTokensByLane.delete(laneKey)
      }
      if (!holdHomeLockUntilExit) {
        markProcessClosed()
      }
      resolve(result)
    }

    cancelToken = () => {
      canceledByUser = true
      startTermination()
      // Why: cancellation is a user-visible UI command; do not wait for a
      // wedged agent CLI to emit `close` before the request leaves loading.
      finalize({ success: false, error: 'Generation canceled.', canceled: true })
    }
    cancelTokensByLane.set(laneKey, cancelToken)

    timer = setTimeout(() => {
      startTermination()
      finalize({
        success: false,
        error: `Generation timed out after ${GENERATION_TIMEOUT_MS / 1000}s.`
      })
    }, GENERATION_TIMEOUT_MS)

    const onStdoutData = (chunk: Buffer): void => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > MAX_AGENT_OUTPUT_BYTES) {
        outputLimitExceeded = true
        startTermination()
        return
      }
      stdout += chunk.toString('utf-8')
    }
    const onStderrData = (chunk: Buffer): void => {
      stderrBytes += chunk.byteLength
      if (stderrBytes > MAX_AGENT_OUTPUT_BYTES) {
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
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        finalize({
          success: false,
          error: `${binary} not found on PATH. Install ${label} to use AI commit messages.`
        })
        return
      }
      console.error('[commit-message] Local generator failed after spawn:', error)
      finalize({
        success: false,
        error: `${label} failed to start. Check the agent command in Settings and try again.`
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
          error: `${label} CLI command produced too much output. Check the agent CLI configuration and try again.`
        })
        return
      }
      finalizeFromAgentOutput({
        code,
        stdout,
        stderr,
        label,
        emptyResultName,
        finalize,
        includeStdoutDetail: operation !== 'branch-name'
      })
    }
    child.stdout?.on('data', onStdoutData)
    child.stderr?.on('data', onStderrData)
    if (holdHomeLockUntilExit) {
      // Why: 'close' also waits on descendants that inherited this child's
      // stdio, so a surviving MCP helper would hold the home forever; at 'exit'
      // the codex process is gone and can no longer rotate auth.json.
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
      child.stdin?.end(stdinPayload ?? undefined)
    } catch (error) {
      startTermination()
      onError(error instanceof Error ? error : new Error(String(error)))
    }
  })
  return { result, processClosed }
}

type LocalGenerationTarget = Extract<CommitMessageGenerationTarget, { kind: 'local' }>

function runLocalPlanForAgent(
  agentId: string,
  plan: CommitMessagePlan,
  target: LocalGenerationTarget,
  emptyResultName: string,
  operation: TextGenerationOperation
): Promise<InternalTextGenerationResult> {
  const start = (
    holdHomeLockUntilExit = false
  ): LocalProcessExecution<InternalTextGenerationResult> =>
    runLocalPlan(
      plan,
      target.cwd,
      target.env,
      emptyResultName,
      operation,
      target.wslDistro,
      holdHomeLockUntilExit
    )
  if (agentId !== 'codex') {
    // Why: no extra promise hops here — cancellation timing for non-codex
    // agents must stay byte-identical to a direct runLocalPlan call.
    return start().result
  }
  return runCodexLocalPlanUnderHomeLock(() => start(true), target, operation)
}

// Why: codex rewrites rotating OAuth tokens in its home's auth.json; the
// per-home lock keeps this run from racing Orca's own quota probes there.
function runCodexLocalPlanUnderHomeLock(
  start: () => LocalProcessExecution<InternalTextGenerationResult>,
  target: LocalGenerationTarget,
  operation: TextGenerationOperation
): Promise<InternalTextGenerationResult> {
  const laneKey = localLaneKey(operation, target.cwd)
  let canceledWhileQueued = false
  let publishResult!: (result: InternalTextGenerationResult) => void
  let rejectResult!: (error: unknown) => void
  let resultPublished = false
  const result = new Promise<InternalTextGenerationResult>((resolve, reject) => {
    publishResult = (value) => {
      if (!resultPublished) {
        resultPublished = true
        resolve(value)
      }
    }
    rejectResult = reject
  })
  const queuedCancelToken = (): void => {
    canceledWhileQueued = true
    publishResult({ success: false, error: 'Generation canceled.', canceled: true })
  }
  // Why: Stop must work while this run waits behind a probe holding the lock.
  cancelTokensByLane.set(laneKey, queuedCancelToken)
  void withCodexHomeProcessLock(
    resolveCodexHomeProcessLockKeyForSpawnEnv(target.env, target.wslDistro),
    async () => {
      if (canceledWhileQueued) {
        publishResult({ success: false, error: 'Generation canceled.', canceled: true })
        return
      }
      const execution = start()
      try {
        publishResult(await execution.result)
      } catch (error) {
        if (!resultPublished) {
          rejectResult(error)
        }
      } finally {
        await execution.processClosed
      }
    }
  )
    .catch((error: unknown) => {
      if (!resultPublished) {
        rejectResult(error)
      }
    })
    .finally(() => {
      if (cancelTokensByLane.get(laneKey) === queuedCancelToken) {
        cancelTokensByLane.delete(laneKey)
      }
    })
  return result
}

function runCodexProcessWithHomeLock<T>(
  lockKey: string,
  start: () => LocalProcessExecution<T>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    void withCodexHomeProcessLock(lockKey, async () => {
      const execution = start()
      try {
        resolve(await execution.result)
      } catch (error) {
        reject(error)
      } finally {
        await execution.processClosed
      }
    }).catch(reject)
  })
}

function finalizeFromAgentOutput(args: {
  code: number | null
  stdout: string
  stderr: string
  label: string
  emptyResultName: string
  finalize: (result: InternalTextGenerationResult) => void
  includeLocalMacDnsHint?: boolean
  includeStdoutDetail?: boolean
}): void {
  const {
    code,
    stdout,
    stderr,
    label,
    emptyResultName,
    finalize,
    includeLocalMacDnsHint,
    includeStdoutDetail
  } = args
  if (code !== 0) {
    console.error('[commit-message] Generator failed:', {
      label,
      exitCode: code,
      stdout,
      stderr
    })
    finalize({
      success: false,
      error: formatAgentCliFailureMessage(label, stdout, stderr, code, {
        includeLocalMacDnsHint,
        includeStdoutDetail
      }),
      failureOutput: captureAgentGenerationFailureOutput(label, code, stdout, stderr) ?? undefined
    })
    return
  }
  const cleaned = cleanGeneratedCommitMessage(stdout)
  if (!cleaned) {
    // stdout is the (empty) result here, not diagnostics, so only stderr is
    // excerpted. The run exited 0, so this stays "returned an empty result"
    // rather than misreporting a command failure.
    const detail = sanitizeAgentFailureDetail(excerptAgentFailureOutput('', stderr))
    if (detail) {
      console.error('[commit-message] Generator returned no stdout but wrote to stderr:', {
        label,
        exitCode: code,
        stdout,
        stderr
      })
    }
    finalize({
      success: false,
      error: detail
        ? `${label} returned an empty ${emptyResultName}. CLI output: ${detail}`
        : `${label} returned an empty ${emptyResultName}.`,
      failureOutput: captureAgentGenerationFailureOutput(label, code, stdout, stderr) ?? undefined
    })
    return
  }
  finalize({
    success: true,
    rawOutput: cleaned,
    agentLabel: label
  })
}

async function runRemotePlan(
  plan: CommitMessagePlan,
  target: Extract<CommitMessageGenerationTarget, { kind: 'remote' }>,
  emptyResultName = 'message',
  operation: TextGenerationOperation = 'commit-message'
): Promise<InternalTextGenerationResult> {
  const { binary, label } = plan
  let result: RemoteCommitMessageExecResult
  try {
    result = await target.execute(plan, target.cwd, GENERATION_TIMEOUT_MS, operation)
  } catch (error) {
    console.error('[commit-message] Remote generator request failed:', error)
    if (isSshMuxRequestTimeoutError(error)) {
      return {
        success: false,
        error: `${label} took longer than ${GENERATION_TIMEOUT_MS / 1000}s to respond and may still be running on the remote host.`
      }
    }
    return {
      success: false,
      error: `${label} could not be reached on the ${target.missingBinaryLocation}. Try again after the SSH connection recovers.`
    }
  }
  if (result.spawnError) {
    if (result.spawnError === WINDOWS_BATCH_UNSAFE_ARGUMENTS_ERROR) {
      return {
        success: false,
        error: userFacingUnsafeWindowsBatchArgs(label)
      }
    }
    if (/ENOENT/i.test(result.spawnError)) {
      return {
        success: false,
        error: `${binary} not found on the ${target.missingBinaryLocation}. Install ${label} there.`
      }
    }
    console.error('[commit-message] Remote generator spawn failed:', result.spawnError)
    return {
      success: false,
      error: `${label} could not be started on the ${target.missingBinaryLocation}. Check the agent command there and try again.`
    }
  }
  if (result.canceled) {
    return { success: false, error: 'Generation canceled.', canceled: true }
  }
  if (result.timedOut) {
    return {
      success: false,
      error: `Generation timed out after ${GENERATION_TIMEOUT_MS / 1000}s.`
    }
  }

  return new Promise((resolve) => {
    finalizeFromAgentOutput({
      code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      label,
      emptyResultName,
      finalize: resolve,
      // Why: remote agent output reflects the SSH target, not this Mac's DNS.
      includeLocalMacDnsHint: false,
      // Branch failures persist into synced metadata; stdout may echo the prompt.
      includeStdoutDetail: operation !== 'branch-name'
    })
  })
}

function formatCommitMessageGenerationResult(
  result: InternalTextGenerationResult
): GenerateCommitMessageResult {
  if (!result.success) {
    // Keep the bulky local-only capture off the renderer-bound payload.
    return { success: false, error: result.error, canceled: result.canceled }
  }
  let commitMessage: GeneratedCommitMessage
  try {
    commitMessage = splitGeneratedCommitMessage(result.rawOutput)
  } catch {
    return { success: false, error: 'Generated commit message could not be parsed.' }
  }
  return {
    success: true,
    message: trimGeneratedCommitMessage(commitMessage.message),
    agentLabel: result.agentLabel
  }
}

export async function generateCommitMessageFromContext(
  context: CommitMessageDraftContext,
  params: GenerateCommitMessageParams,
  target: CommitMessageGenerationTarget
): Promise<GenerateCommitMessageResult> {
  const basePrompt = buildCommitMessagePrompt(context, '')
  const prompt =
    params.commandInputTemplate !== undefined
      ? renderSourceControlActionCommandTemplate(params.commandInputTemplate, {
          basePrompt,
          branch: context.branch ?? '(detached)',
          stagedFiles: context.stagedSummary,
          stagedPatch: context.stagedPatch,
          // Why: always pass the key so `{linkedIssue}` never survives as a literal token.
          linkedIssue: formatLinkedIssueTemplateValue(context.linkedIssue)
        })
      : buildCommitMessagePrompt(context, params.customPrompt ?? '')
  const planned = planCommitMessageGeneration(params, prompt)
  if (!planned.ok) {
    return { success: false, error: planned.error }
  }

  const internalResult =
    target.kind === 'remote'
      ? await runRemotePlan(planned.plan, target)
      : await runLocalPlanForAgent(
          params.agentId,
          planned.plan,
          target,
          'message',
          'commit-message'
        )
  return formatCommitMessageGenerationResult(internalResult)
}

export function cancelGeneratePullRequestFieldsLocal(cwd: string): void {
  cancelTokensByLane.get(localLaneKey('pull-request-fields', cwd))?.()
}

function formatPullRequestFieldsGenerationResult(
  result: InternalTextGenerationResult,
  context: PullRequestDraftContext
): GeneratePullRequestFieldsResult {
  if (!result.success) {
    // Keep the bulky local-only capture off the renderer-bound payload.
    return {
      success: false,
      error: result.error,
      canceled: result.canceled,
      branchChangedByPreparation: context.branchChangedByPreparation
    }
  }
  try {
    return {
      success: true,
      fields: parseGeneratedPullRequestFields(result.rawOutput, context),
      agentLabel: result.agentLabel,
      branchChangedByPreparation: context.branchChangedByPreparation
    }
  } catch {
    return {
      success: false,
      error: 'Generated pull request details could not be parsed.',
      branchChangedByPreparation: context.branchChangedByPreparation
    }
  }
}

export async function generatePullRequestFieldsFromContext(
  context: PullRequestDraftContext,
  params: GenerateCommitMessageParams,
  target: CommitMessageGenerationTarget
): Promise<GeneratePullRequestFieldsResult> {
  const basePrompt = buildPullRequestFieldsPrompt(context, '')
  const prompt =
    params.commandInputTemplate !== undefined
      ? renderSourceControlActionCommandTemplate(params.commandInputTemplate, {
          basePrompt,
          branch: context.branch ?? '(detached)',
          baseBranch: context.base,
          currentTitle: context.currentTitle,
          currentBody: context.currentBody,
          commitSummary: context.commitSummary,
          changedFiles: context.changeSummary,
          patch: context.patch,
          // Why: always pass the key so `{linkedIssue}` never survives as a literal token.
          linkedIssue: formatLinkedIssueTemplateValue(context.linkedIssue)
        })
      : buildPullRequestFieldsPrompt(context, params.customPrompt ?? '')
  const planned = planCommitMessageGeneration(params, prompt)
  if (!planned.ok) {
    return {
      success: false,
      error: planned.error,
      branchChangedByPreparation: context.branchChangedByPreparation
    }
  }

  const internalResult =
    target.kind === 'remote'
      ? await runRemotePlan(planned.plan, target, 'details', 'pull-request-fields')
      : await runLocalPlanForAgent(
          params.agentId,
          planned.plan,
          target,
          'details',
          'pull-request-fields'
        )
  return formatPullRequestFieldsGenerationResult(internalResult, context)
}

export type GenerateBranchNameResult =
  | { success: true; slug: string; agentLabel?: string }
  | {
      success: false
      error: string
      canceled?: boolean
      failureOutput?: AgentGenerationFailureOutput
    }

/**
 * Generate a short kebab-case branch name from the work the agent is starting.
 * Reuses the commit-message generation plan + spawn machinery; only the prompt
 * and the post-processing (slug sanitization) differ.
 */
export async function generateBranchNameFromContext(
  context: BranchNameWorkContext,
  params: GenerateCommitMessageParams,
  target: CommitMessageGenerationTarget
): Promise<GenerateBranchNameResult> {
  const basePrompt = buildBranchNamePrompt(context)
  const prompt =
    params.commandInputTemplate !== undefined
      ? renderSourceControlActionCommandTemplate(params.commandInputTemplate, {
          basePrompt,
          firstPrompt: context.firstPrompt,
          assistantMessage: context.assistantMessage ?? ''
        })
      : buildBranchNamePrompt(context, params.customPrompt ?? '')
  const planned = planCommitMessageGeneration(params, prompt)
  if (!planned.ok) {
    return { success: false, error: planned.error }
  }

  const internalResult =
    target.kind === 'remote'
      ? await runRemotePlan(planned.plan, target, 'branch name', 'branch-name')
      : await runLocalPlanForAgent(
          params.agentId,
          planned.plan,
          target,
          'branch name',
          'branch-name'
        )
  if (!internalResult.success) {
    return internalResult
  }
  const slug = sanitizeBranchSlug(internalResult.rawOutput)
  if (!slug) {
    return {
      success: false,
      error: 'Generated branch name was empty after sanitization.',
      // What the model actually returned is the whole diagnosis here.
      failureOutput:
        captureAgentGenerationFailureOutput(planned.plan.label, 0, internalResult.rawOutput, '') ??
        undefined
    }
  }
  return { success: true, slug, agentLabel: internalResult.agentLabel }
}
