/* eslint-disable max-lines -- Why: local and SSH generation share cancellation,
   spawn failure handling, and output normalization; keeping them together
   prevents those paths from drifting. */
import { exec, spawn, type ChildProcess } from 'child_process'
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
  extractAgentErrorMessage
} from '../../shared/commit-message-prompt'
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
import { resolveCliCommand } from '../codex-cli/command'
import {
  getSpawnArgsForWindows,
  UnsafeWindowsBatchArgumentsError,
  WINDOWS_BATCH_UNSAFE_ARGUMENTS_ERROR
} from '../win32-utils'
import { withMacTailscaleDnsHint } from '../network/macos-tailscale-dns-diagnostic'

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
  | { kind: 'local'; cwd: string; env?: NodeJS.ProcessEnv }
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
  | { success: false; error: string; canceled?: boolean }

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

function sanitizeAgentFailureDetail(detail: string | null): string | null {
  const trimmed = detail?.replace(/\p{Cc}+/gu, ' ').trim()
  if (!trimmed) {
    return null
  }
  return trimmed.length > 240 ? `${trimmed.slice(0, 240).trimEnd()}...` : trimmed
}

function userFacingAgentFailure(
  label: string,
  detail?: string | null,
  options?: { includeLocalMacDnsHint?: boolean }
): string {
  const message = `${label} failed. Check the agent CLI configuration and try again.`
  return options?.includeLocalMacDnsHint === false
    ? message
    : withMacTailscaleDnsHint(message, detail)
}

function userFacingUnsafeWindowsBatchArgs(label: string): string {
  return `${label} cannot be run as a Windows batch command with the prompt in argv. Remove {prompt} so Orca sends the prompt on stdin.`
}

function toModelDiscoveryCapability(
  spec: NonNullable<ReturnType<typeof getCommitMessageAgentSpec>>,
  models = spec.models,
  defaultModelId = spec.defaultModelId
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
    defaultModelId
  }
}

function finalizeModelDiscoveryOutput(
  spec: NonNullable<ReturnType<typeof getCommitMessageAgentSpec>>,
  stdout: string,
  stderr: string,
  code: number | null
): DiscoverCommitMessageModelsResult {
  if (code !== 0) {
    const safeDetail = sanitizeAgentFailureDetail(extractAgentErrorMessage(stdout, stderr))
    console.error('[commit-message] Model discovery failed:', {
      label: spec.label,
      exitCode: code,
      safeDetail,
      stdout,
      stderr
    })
    return {
      success: false,
      error: withMacTailscaleDnsHint(
        `${spec.label} model discovery failed. Check the agent CLI configuration and try again.`,
        safeDetail
      )
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
  return toModelDiscoveryCapability(spec, models, defaultModelId)
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
      stdinPayload: null,
      label: spec.label
    }
  }
}

export async function discoverCommitMessageModelsLocal(
  agentId: TuiAgent,
  env: NodeJS.ProcessEnv | undefined,
  agentCommandOverride?: string
): Promise<DiscoverCommitMessageModelsResult> {
  const spec = getCommitMessageAgentSpec(agentId)
  if (!spec) {
    return { success: false, error: `Agent "${agentId}" does not support AI commit messages.` }
  }

  if (spec.modelSource === 'static' || !spec.modelDiscovery) {
    return toModelDiscoveryCapability(spec)
  }

  return new Promise((resolve) => {
    let child: ChildProcess
    const spawnEnv = env ?? process.env
    try {
      const planned = planModelDiscovery(spec, agentCommandOverride)
      if (!planned.ok) {
        resolve({ success: false, error: planned.error })
        return
      }
      const resolvedBinary =
        process.platform === 'win32'
          ? resolveCliCommand(planned.plan.binary, {
              pathEnv: spawnEnv.PATH ?? spawnEnv.Path ?? null
            })
          : planned.plan.binary
      const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(resolvedBinary, planned.plan.args)
      child = spawn(spawnCmd, spawnArgs, {
        env: spawnEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
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
    const finish = (result: DiscoverCommitMessageModelsResult): void => {
      if (settled) {
        return
      }
      settled = true
      resolve(result)
    }
    const timer = setTimeout(() => {
      killProcessTree(child)
      finish({
        success: false,
        error: `${spec.label} model discovery timed out after ${GENERATION_TIMEOUT_MS / 1000}s.`
      })
    }, GENERATION_TIMEOUT_MS)

    const onData = (chunk: Buffer, append: (text: string) => void): void => {
      if (stdout.length + stderr.length + chunk.byteLength > MAX_AGENT_OUTPUT_BYTES) {
        outputLimitExceeded = true
        killProcessTree(child)
        return
      }
      append(chunk.toString('utf-8'))
    }

    child.stdout?.on('data', (chunk: Buffer) => onData(chunk, (text) => (stdout += text)))
    child.stderr?.on('data', (chunk: Buffer) => onData(chunk, (text) => (stderr += text)))
    child.on('error', (error) => {
      clearTimeout(timer)
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
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (outputLimitExceeded) {
        finish({ success: false, error: `${spec.label} returned too much model data.` })
        return
      }
      if (code !== 0) {
        finish(finalizeModelDiscoveryOutput(spec, stdout, stderr, code))
        return
      }
      finish(finalizeModelDiscoveryOutput(spec, stdout, stderr, code))
    })
  })
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
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) {
    return
  }
  if (process.platform === 'win32') {
    exec(`taskkill /pid ${pid} /T /F`, () => {
      // Best-effort; the spawn's `close` listener fires once the tree exits.
    })
    return
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // The child may have already exited between the in-flight check and the
    // kill - that race is benign and can be ignored.
  }
}

// Keying by operation plus `local:${cwd}` keeps local cancellation independent
// from SSH worktrees and from other generation features in the same worktree.
const cancelTokensByLane = new Map<string, () => void>()

function localLaneKey(operation: TextGenerationOperation, cwd: string): string {
  return `${operation}:local:${cwd}`
}

export function cancelGenerateCommitMessageLocal(cwd: string): void {
  cancelTokensByLane.get(localLaneKey('commit-message', cwd))?.()
}

async function runLocalPlan(
  plan: CommitMessagePlan,
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  emptyResultName = 'message',
  operation: TextGenerationOperation = 'commit-message'
): Promise<InternalTextGenerationResult> {
  const { binary, args, stdinPayload, label } = plan
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      const spawnEnv = env ?? process.env
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
    } catch (error) {
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
    let detachChildListeners = (): void => {}
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
      resolve(result)
    }

    cancelToken = () => {
      canceledByUser = true
      killProcessTree(child)
      // Why: cancellation is a user-visible UI command; do not wait for a
      // wedged agent CLI to emit `close` before the request leaves loading.
      finalize({ success: false, error: 'Generation canceled.', canceled: true })
    }
    cancelTokensByLane.set(laneKey, cancelToken)

    timer = setTimeout(() => {
      killProcessTree(child)
      finalize({
        success: false,
        error: `Generation timed out after ${GENERATION_TIMEOUT_MS / 1000}s.`
      })
    }, GENERATION_TIMEOUT_MS)

    const onStdoutData = (chunk: Buffer): void => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > MAX_AGENT_OUTPUT_BYTES) {
        outputLimitExceeded = true
        killProcessTree(child)
        return
      }
      stdout += chunk.toString('utf-8')
    }
    const onStderrData = (chunk: Buffer): void => {
      stderrBytes += chunk.byteLength
      if (stderrBytes > MAX_AGENT_OUTPUT_BYTES) {
        outputLimitExceeded = true
        killProcessTree(child)
        return
      }
      stderr += chunk.toString('utf-8')
    }
    const onError = (error: Error): void => {
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
      if (canceledByUser) {
        finalize({ success: false, error: 'Generation canceled.', canceled: true })
        return
      }
      if (outputLimitExceeded) {
        finalize({ success: false, error: userFacingAgentFailure(label) })
        return
      }
      finalizeFromAgentOutput({ code, stdout, stderr, label, emptyResultName, finalize })
    }
    child.stdout?.on('data', onStdoutData)
    child.stderr?.on('data', onStderrData)
    child.on('error', onError)
    child.on('close', onClose)
    detachChildListeners = () => {
      child.stdout?.off?.('data', onStdoutData)
      child.stderr?.off?.('data', onStderrData)
      child.off?.('error', onError)
      child.off?.('close', onClose)
    }

    child.stdin?.end(stdinPayload ?? undefined)
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
}): void {
  const { code, stdout, stderr, label, emptyResultName, finalize, includeLocalMacDnsHint } = args
  if (code !== 0) {
    const safeDetail = sanitizeAgentFailureDetail(extractAgentErrorMessage(stdout, stderr))
    console.error('[commit-message] Generator failed:', {
      label,
      exitCode: code,
      safeDetail,
      stdout,
      stderr
    })
    finalize({
      success: false,
      error: userFacingAgentFailure(label, safeDetail, { includeLocalMacDnsHint })
    })
    return
  }
  const cleaned = cleanGeneratedCommitMessage(stdout)
  if (!cleaned) {
    const safeDetail = sanitizeAgentFailureDetail(extractAgentErrorMessage(stdout, stderr))
    if (safeDetail) {
      console.error('[commit-message] Generator returned no stdout but reported an error:', {
        label,
        exitCode: code,
        safeDetail,
        stdout,
        stderr
      })
      finalize({
        success: false,
        error: userFacingAgentFailure(label, safeDetail, { includeLocalMacDnsHint })
      })
      return
    }
    finalize({ success: false, error: `${label} returned an empty ${emptyResultName}.` })
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
      includeLocalMacDnsHint: false
    })
  })
}

function formatCommitMessageGenerationResult(
  result: InternalTextGenerationResult
): GenerateCommitMessageResult {
  if (!result.success) {
    return result
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
  const prompt = buildCommitMessagePrompt(context, params.customPrompt ?? '')
  const planned = planCommitMessageGeneration(params, prompt)
  if (!planned.ok) {
    return { success: false, error: planned.error }
  }

  const internalResult =
    target.kind === 'remote'
      ? await runRemotePlan(planned.plan, target)
      : await runLocalPlan(planned.plan, target.cwd, target.env)
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
    return {
      ...result,
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
  const prompt = buildPullRequestFieldsPrompt(context, params.customPrompt ?? '')
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
      : await runLocalPlan(planned.plan, target.cwd, target.env, 'details', 'pull-request-fields')
  return formatPullRequestFieldsGenerationResult(internalResult, context)
}

export type GenerateBranchNameResult =
  | { success: true; slug: string; agentLabel?: string }
  | { success: false; error: string; canceled?: boolean }

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
  const prompt = buildBranchNamePrompt(context, params.customPrompt ?? '')
  const planned = planCommitMessageGeneration(params, prompt)
  if (!planned.ok) {
    return { success: false, error: planned.error }
  }

  const internalResult =
    target.kind === 'remote'
      ? await runRemotePlan(planned.plan, target, 'branch name', 'branch-name')
      : await runLocalPlan(planned.plan, target.cwd, target.env, 'branch name', 'branch-name')
  if (!internalResult.success) {
    return internalResult
  }
  const slug = sanitizeBranchSlug(internalResult.rawOutput)
  if (!slug) {
    return { success: false, error: 'Generated branch name was empty after sanitization.' }
  }
  return { success: true, slug, agentLabel: internalResult.agentLabel }
}
