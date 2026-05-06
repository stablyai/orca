import { spawn } from 'child_process'
import {
  COMMIT_MESSAGE_AGENT_SPECS,
  getCommitMessageAgentSpec,
  getCommitMessageModel,
  type CommitMessageAgentSpec
} from '../../shared/commit-message-agent-spec'
import {
  buildCommitPrompt,
  cleanGeneratedCommitMessage,
  extractAgentErrorMessage,
  truncateDiffForPrompt
} from '../../shared/commit-message-prompt'
import { ORCA_GIT_COMMIT_TRAILER } from '../../shared/orca-attribution'
import type { TuiAgent } from '../../shared/types'
import { getStagedDiff } from './status'

const GENERATION_TIMEOUT_MS = 60_000

export type GenerateCommitMessageParams = {
  worktreePath: string
  agentId: TuiAgent
  model: string
  thinkingLevel?: string
  customPrompt?: string
  /** When true, append `Co-authored-by: Orca …` after the cleaned message. */
  attributionEnabled?: boolean
}

/** Appends the Orca trailer if the message does not already include it. */
export function applyOrcaAttribution(message: string, enabled: boolean): string {
  if (!enabled) {
    return message
  }
  if (message.includes(ORCA_GIT_COMMIT_TRAILER)) {
    return message
  }
  // Why: a blank line separates the trailer block from the body so `git
  // interpret-trailers` and most parsers treat it as a real trailer instead
  // of a paragraph continuation.
  return `${message.replace(/\s+$/, '')}\n\n${ORCA_GIT_COMMIT_TRAILER}\n`
}

export type GenerateCommitMessageResult =
  | { success: true; message: string }
  | { success: false; error: string }

/**
 * Validates user-supplied params against the spec. Surfaces a single
 * actionable error per failure so the renderer can show it inline.
 */
function validateParams(
  params: GenerateCommitMessageParams
): { spec: CommitMessageAgentSpec } | { error: string } {
  const spec = getCommitMessageAgentSpec(params.agentId)
  if (!spec) {
    return { error: `Agent "${params.agentId}" does not support AI commit messages.` }
  }
  const model = getCommitMessageModel(params.agentId, params.model)
  if (!model) {
    return { error: `Model "${params.model}" is not available for ${spec.label}.` }
  }
  if (params.thinkingLevel) {
    if (!model.thinkingLevels) {
      return { error: `Model "${model.label}" does not support a thinking effort level.` }
    }
    if (!model.thinkingLevels.some((l) => l.id === params.thinkingLevel)) {
      return {
        error: `Thinking level "${params.thinkingLevel}" is not valid for ${model.label}.`
      }
    }
  }
  return { spec }
}

/**
 * Spawns the agent CLI in non-interactive mode, feeds the prompt via argv or
 * stdin per the spec, and returns the captured stdout. Always returns a
 * GenerateCommitMessageResult — never throws — so the IPC handler can
 * round-trip the failure to the renderer for inline display.
 */
async function runAgent(
  spec: CommitMessageAgentSpec,
  args: string[],
  promptForStdin: string | null,
  cwd: string,
  attributionEnabled: boolean
): Promise<GenerateCommitMessageResult> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(spec.binary, args, {
        cwd,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
      resolve({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const finalize = (result: GenerateCommitMessageResult): void => {
      if (settled) {
        return
      }
      settled = true
      resolve(result)
    }

    const timer = setTimeout(() => {
      // Why: SIGKILL because some CLIs trap SIGTERM and continue streaming
      // tokens, which keeps the parent waiting indefinitely.
      child.kill('SIGKILL')
      finalize({
        success: false,
        error: `Generation timed out after ${GENERATION_TIMEOUT_MS / 1000}s.`
      })
    }, GENERATION_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        finalize({
          success: false,
          error: `${spec.binary} not found on PATH. Install ${spec.label} to use AI commit messages.`
        })
        return
      }
      finalize({ success: false, error: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        // Why: agent CLIs print a runtime preamble + the echoed prompt + hook
        // lifecycle messages before any error line, so the raw stderr/stdout
        // is unreadable. Try to surface the actual error first, then fall
        // back to the trimmed channels.
        const extracted = extractAgentErrorMessage(stdout, stderr)
        const detail = extracted ?? stderr.trim() ?? stdout.trim() ?? `exit code ${code}`
        finalize({ success: false, error: `${spec.label} failed: ${detail}` })
        return
      }
      const cleaned = cleanGeneratedCommitMessage(stdout)
      if (!cleaned) {
        finalize({ success: false, error: `${spec.label} returned an empty message.` })
        return
      }
      finalize({ success: true, message: applyOrcaAttribution(cleaned, attributionEnabled) })
    })

    if (promptForStdin !== null) {
      child.stdin?.end(promptForStdin)
    } else {
      child.stdin?.end()
    }
  })
}

export async function generateCommitMessageLocal(
  params: GenerateCommitMessageParams
): Promise<GenerateCommitMessageResult> {
  const validation = validateParams(params)
  if ('error' in validation) {
    return { success: false, error: validation.error }
  }
  const { spec } = validation

  let diff: string
  try {
    diff = await getStagedDiff(params.worktreePath)
  } catch (error) {
    return {
      success: false,
      error: `Failed to read staged diff: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (!diff.trim()) {
    return { success: false, error: 'No staged changes to summarize.' }
  }

  const prompt = buildCommitPrompt(truncateDiffForPrompt(diff), params.customPrompt ?? '')
  const argvPrompt = spec.promptDelivery === 'argv' ? prompt : ''
  const args = spec.buildArgs({
    prompt: argvPrompt,
    model: params.model,
    thinkingLevel: params.thinkingLevel
  })
  const stdinPayload = spec.promptDelivery === 'stdin' ? prompt : null
  return runAgent(spec, args, stdinPayload, params.worktreePath, params.attributionEnabled === true)
}

/** Re-export so the IPC layer can validate agent ids at the boundary. */
export { COMMIT_MESSAGE_AGENT_SPECS }
