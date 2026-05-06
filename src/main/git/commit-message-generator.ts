import { exec, spawn, type ChildProcess } from 'child_process'
import {
  COMMIT_MESSAGE_AGENT_SPECS,
  getCommitMessageAgentSpec,
  getCommitMessageModel,
  isCustomAgentId
} from '../../shared/commit-message-agent-spec'

// Why: on Windows, npm-installed CLIs like `claude` and `codex` are `.cmd`
// shims — Node's `spawn` launches them through an implicit `cmd.exe /d /s /c`
// wrapper, so `child.kill()` only terminates that wrapper and leaves the real
// node.exe process running. `taskkill /T /F` walks the process tree from the
// wrapper PID and force-kills every descendant, which is what users expect
// when they hit "stop generating".
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
    // kill — that race is benign and can be ignored.
  }
}
import {
  buildCommitPrompt,
  cleanGeneratedCommitMessage,
  extractAgentErrorMessage,
  planCustomCommand,
  truncateDiffForPrompt
} from '../../shared/commit-message-prompt'
import { ORCA_GIT_COMMIT_TRAILER } from '../../shared/orca-attribution'
import type { TuiAgent } from '../../shared/types'
import { getStagedDiff } from './status'

const GENERATION_TIMEOUT_MS = 60_000

export type GenerateCommitMessageParams = {
  worktreePath: string
  agentId: TuiAgent | 'custom'
  model: string
  thinkingLevel?: string
  customPrompt?: string
  /** Required when agentId === 'custom': the user-supplied command template. */
  customAgentCommand?: string
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
  | { success: false; error: string; canceled?: boolean }

// Why: a single in-flight generation per worktree is enough — the renderer
// gates double-clicks via generateInFlightRef, so this map is at most 1:1.
// Keying by `${connectionId ?? 'local'}:${worktreePath}` lets the cancel IPC
// route to the same lane the start IPC used.
const cancelTokensByLane = new Map<string, () => void>()

function localLaneKey(worktreePath: string): string {
  return `local:${worktreePath}`
}

/** Kills the in-flight local generation for a worktree, if any. No-op
 *  otherwise (the SSH path cancels remotely via the relay). */
export function cancelGenerateCommitMessageLocal(worktreePath: string): void {
  const cancel = cancelTokensByLane.get(localLaneKey(worktreePath))
  if (cancel) {
    cancel()
  }
}

type PresetPlan = {
  kind: 'preset'
  binary: string
  label: string
  args: string[]
  stdinPayload: string | null
}
type CustomPlan = {
  kind: 'custom'
  binary: string
  label: string
  args: string[]
  stdinPayload: string | null
}
type ResolvedPlan = PresetPlan | CustomPlan

/**
 * Validates the request and produces a spawn-ready plan. Surfaces a single
 * actionable error per failure so the renderer can show it inline.
 */
function planGeneration(
  params: GenerateCommitMessageParams,
  prompt: string
): ResolvedPlan | { error: string } {
  if (isCustomAgentId(params.agentId)) {
    const command = params.customAgentCommand?.trim() ?? ''
    if (!command) {
      return { error: 'Custom command is empty. Add one in Settings → Git → AI Commit Messages.' }
    }
    const planned = planCustomCommand(command, prompt)
    if (!planned.ok) {
      return { error: planned.error }
    }
    return {
      kind: 'custom',
      binary: planned.binary,
      // Why: the binary doubles as the human-readable label in error prefixes
      // when the user runs a custom command — there is no friendly name.
      label: planned.binary,
      args: planned.args,
      stdinPayload: planned.stdinPayload
    }
  }

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

  const argvPrompt = spec.promptDelivery === 'argv' ? prompt : ''
  const args = spec.buildArgs({
    prompt: argvPrompt,
    model: params.model,
    thinkingLevel: params.thinkingLevel
  })
  const stdinPayload = spec.promptDelivery === 'stdin' ? prompt : null
  return {
    kind: 'preset',
    binary: spec.binary,
    label: spec.label,
    args,
    stdinPayload
  }
}

/**
 * Spawns the agent CLI in non-interactive mode, feeds the prompt via argv or
 * stdin per the spec, and returns the captured stdout. Always returns a
 * GenerateCommitMessageResult — never throws — so the IPC handler can
 * round-trip the failure to the renderer for inline display.
 */
async function runAgent(
  binary: string,
  args: string[],
  promptForStdin: string | null,
  cwd: string,
  attributionEnabled: boolean,
  label: string
): Promise<GenerateCommitMessageResult> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(binary, args, {
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
    let canceledByUser = false
    const laneKey = localLaneKey(cwd)
    const finalize = (result: GenerateCommitMessageResult): void => {
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
      // Why: tree-kill because some CLIs trap SIGTERM and continue streaming
      // tokens, which keeps the parent waiting indefinitely. On Windows the
      // immediate child is a cmd.exe wrapper, so we have to walk the tree.
      killProcessTree(child)
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
          error: `${binary} not found on PATH. Install ${label} to use AI commit messages.`
        })
        return
      }
      finalize({ success: false, error: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (canceledByUser) {
        finalize({ success: false, error: 'Generation canceled.', canceled: true })
        return
      }
      if (code !== 0) {
        // Why: agent CLIs print a runtime preamble + the echoed prompt + hook
        // lifecycle messages before any error line, so the raw stderr/stdout
        // is unreadable. Try to surface the actual error first, then fall
        // back to the trimmed channels.
        const extracted = extractAgentErrorMessage(stdout, stderr)
        const detail = extracted ?? stderr.trim() ?? stdout.trim() ?? `exit code ${code}`
        finalize({ success: false, error: `${label} failed: ${detail}` })
        return
      }
      const cleaned = cleanGeneratedCommitMessage(stdout)
      if (!cleaned) {
        finalize({ success: false, error: `${label} returned an empty message.` })
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
  const plan = planGeneration(params, prompt)
  if ('error' in plan) {
    return { success: false, error: plan.error }
  }
  return runAgent(
    plan.binary,
    plan.args,
    plan.stdinPayload,
    params.worktreePath,
    params.attributionEnabled === true,
    plan.label
  )
}

/** Re-export so the IPC layer can validate agent ids at the boundary. */
export { COMMIT_MESSAGE_AGENT_SPECS }
