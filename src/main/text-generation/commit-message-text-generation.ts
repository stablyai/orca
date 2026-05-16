/* eslint-disable max-lines -- Why: local and SSH generation share cancellation,
   spawn failure handling, and output normalization; keeping them together
   prevents those paths from drifting. */
import { exec, spawn, type ChildProcess } from 'child_process'
import type { GlobalSettings, TuiAgent } from '../../shared/types'
import {
  buildCommitMessagePrompt,
  splitGeneratedCommitMessage,
  type CommitMessageDraftContext,
  type GeneratedCommitMessage
} from '../../shared/commit-message-generation'
import {
  cleanGeneratedCommitMessage,
  extractAgentErrorMessage
} from '../../shared/commit-message-prompt'
import {
  CUSTOM_AGENT_ID,
  getCommitMessageAgentSpec,
  getCommitMessageModel,
  isCustomAgentId,
  resolveCommitMessageAgentChoice
} from '../../shared/commit-message-agent-spec'
import {
  planCommitMessageGeneration,
  type CommitMessagePlan
} from '../../shared/commit-message-plan'
import { resolveCliCommand } from '../codex-cli/command'
import {
  getSpawnArgsForWindows,
  UnsafeWindowsBatchArgumentsError,
  WINDOWS_BATCH_UNSAFE_ARGUMENTS_ERROR
} from '../win32-utils'

const GENERATION_TIMEOUT_MS = 60_000
const MAX_AGENT_OUTPUT_BYTES = 4 * 1024 * 1024

export type GenerateCommitMessageParams = {
  agentId: TuiAgent | 'custom'
  model: string
  thinkingLevel?: string
  customPrompt?: string
  customAgentCommand?: string
  agentCommandOverride?: string
}

export type GenerateCommitMessageResult =
  | { success: true; message: string; agentLabel?: string }
  | { success: false; error: string; canceled?: boolean }

export type RemoteCommitMessageExecResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  canceled?: boolean
  spawnError?: string
}

export type CommitMessageGenerationTarget =
  | { kind: 'local'; cwd: string; env?: NodeJS.ProcessEnv }
  | {
      kind: 'remote'
      cwd: string
      execute: (
        plan: CommitMessagePlan,
        cwd: string,
        timeoutMs: number
      ) => Promise<RemoteCommitMessageExecResult>
      missingBinaryLocation: string
    }

type ResolveCommitMessageSettingsResult =
  | { ok: true; params: GenerateCommitMessageParams }
  | { ok: false; error: string }

type InternalCommitMessageGenerationResult =
  | { success: true; commitMessage: GeneratedCommitMessage; agentLabel?: string }
  | { success: false; error: string; canceled?: boolean }

export function trimGeneratedCommitMessage(message: string): string {
  return message.replace(/\s+$/, '')
}

export function resolveCommitMessageSettings(
  settings: GlobalSettings
): ResolveCommitMessageSettingsResult {
  const config = settings.commitMessageAi
  if (!config?.enabled) {
    return { ok: false, error: 'Enable AI commit messages in Settings -> Git.' }
  }

  const agentChoice = resolveCommitMessageAgentChoice(config.agentId, settings.defaultTuiAgent)
  if (!agentChoice) {
    return {
      ok: false,
      error:
        `Default agent "${settings.defaultTuiAgent}" does not support AI commit messages. ` +
        'Choose Claude or Codex in Settings -> Git -> AI Commit Messages.'
    }
  }

  if (isCustomAgentId(agentChoice)) {
    const customAgentCommand = config.customAgentCommand.trim()
    if (!customAgentCommand) {
      return {
        ok: false,
        error: 'Custom command is empty. Add one in Settings -> Git -> AI Commit Messages.'
      }
    }
    return {
      ok: true,
      params: {
        agentId: CUSTOM_AGENT_ID,
        model: '',
        customPrompt: config.customPrompt,
        customAgentCommand
      }
    }
  }

  const agentId = agentChoice
  const spec = getCommitMessageAgentSpec(agentId)
  if (!spec) {
    return { ok: false, error: `Agent "${agentId}" does not support AI commit messages.` }
  }

  const persistedModelId = config.selectedModelByAgent[agentId] ?? spec.defaultModelId
  const model =
    getCommitMessageModel(agentId, persistedModelId) ??
    getCommitMessageModel(agentId, spec.defaultModelId)
  if (!model) {
    return { ok: false, error: `No model is available for ${spec.label}.` }
  }

  const persistedThinking = config.selectedThinkingByModel[model.id]
  const thinkingLevel = model.thinkingLevels?.some((level) => level.id === persistedThinking)
    ? persistedThinking
    : model.defaultThinkingLevel

  const agentCommandOverride = settings.agentCmdOverrides?.[agentId]?.trim()
  return {
    ok: true,
    params: {
      agentId,
      model: model.id,
      thinkingLevel,
      customPrompt: config.customPrompt,
      ...(agentCommandOverride ? { agentCommandOverride } : {})
    }
  }
}

function sanitizeAgentFailureDetail(detail: string | null): string | null {
  const trimmed = detail?.replace(/\p{Cc}+/gu, ' ').trim()
  if (!trimmed) {
    return null
  }
  return trimmed.length > 240 ? `${trimmed.slice(0, 240).trimEnd()}...` : trimmed
}

function userFacingAgentFailure(label: string): string {
  return `${label} failed. Check the agent CLI configuration and try again.`
}

function userFacingUnsafeWindowsBatchArgs(label: string): string {
  return `${label} cannot be run as a Windows batch command with the prompt in argv. Remove {prompt} so Orca sends the prompt on stdin.`
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

// Keying by `local:${cwd}` keeps local cancellation independent from any SSH
// worktree with the same remote path.
const cancelTokensByLane = new Map<string, () => void>()

function localLaneKey(cwd: string): string {
  return `local:${cwd}`
}

export function cancelGenerateCommitMessageLocal(cwd: string): void {
  cancelTokensByLane.get(localLaneKey(cwd))?.()
}

async function runLocalPlan(
  plan: CommitMessagePlan,
  cwd: string,
  env: NodeJS.ProcessEnv | undefined
): Promise<InternalCommitMessageGenerationResult> {
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
    const laneKey = localLaneKey(cwd)
    const finalize = (result: InternalCommitMessageGenerationResult): void => {
      if (settled) {
        return
      }
      settled = true
      cancelTokensByLane.delete(laneKey)
      resolve(result)
    }

    cancelTokensByLane.set(laneKey, () => {
      canceledByUser = true
      killProcessTree(child)
    })

    const timer = setTimeout(() => {
      killProcessTree(child)
      finalize({
        success: false,
        error: `Generation timed out after ${GENERATION_TIMEOUT_MS / 1000}s.`
      })
    }, GENERATION_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > MAX_AGENT_OUTPUT_BYTES) {
        outputLimitExceeded = true
        killProcessTree(child)
        return
      }
      stdout += chunk.toString('utf-8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength
      if (stderrBytes > MAX_AGENT_OUTPUT_BYTES) {
        outputLimitExceeded = true
        killProcessTree(child)
        return
      }
      stderr += chunk.toString('utf-8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
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
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (canceledByUser) {
        finalize({ success: false, error: 'Generation canceled.', canceled: true })
        return
      }
      if (outputLimitExceeded) {
        finalize({ success: false, error: userFacingAgentFailure(label) })
        return
      }
      finalizeFromAgentOutput({ code, stdout, stderr, label, finalize })
    })

    child.stdin?.end(stdinPayload ?? undefined)
  })
}

function finalizeFromAgentOutput(args: {
  code: number | null
  stdout: string
  stderr: string
  label: string
  finalize: (result: InternalCommitMessageGenerationResult) => void
}): void {
  const { code, stdout, stderr, label, finalize } = args
  if (code !== 0) {
    const safeDetail = sanitizeAgentFailureDetail(extractAgentErrorMessage(stdout, stderr))
    console.error('[commit-message] Generator failed:', {
      label,
      exitCode: code,
      safeDetail,
      stdout,
      stderr
    })
    finalize({ success: false, error: userFacingAgentFailure(label) })
    return
  }
  const cleaned = cleanGeneratedCommitMessage(stdout)
  if (!cleaned) {
    finalize({ success: false, error: `${label} returned an empty message.` })
    return
  }
  const commitMessage = splitGeneratedCommitMessage(cleaned)
  finalize({
    success: true,
    commitMessage,
    agentLabel: label
  })
}

async function runRemotePlan(
  plan: CommitMessagePlan,
  target: Extract<CommitMessageGenerationTarget, { kind: 'remote' }>
): Promise<InternalCommitMessageGenerationResult> {
  const { binary, label } = plan
  let result: RemoteCommitMessageExecResult
  try {
    result = await target.execute(plan, target.cwd, GENERATION_TIMEOUT_MS)
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
      finalize: resolve
    })
  })
}

function formatCommitMessageGenerationResult(
  result: InternalCommitMessageGenerationResult
): GenerateCommitMessageResult {
  if (!result.success) {
    return result
  }
  return {
    success: true,
    message: trimGeneratedCommitMessage(result.commitMessage.message),
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
