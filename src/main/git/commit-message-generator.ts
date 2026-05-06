import { exec, spawn, type ChildProcess } from 'child_process'
import { COMMIT_MESSAGE_AGENT_SPECS } from '../../shared/commit-message-agent-spec'
import {
  planCommitMessageGeneration,
  type CommitMessagePlan
} from '../../shared/commit-message-plan'

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
    // Why: trim trailing whitespace even on the no-attribution path so a
    // stray "\n" from the agent's output never reaches the textarea as a
    // visible blank line.
    return message.replace(/\s+$/, '')
  }
  const stripped = message.replace(/\s+$/, '')
  if (stripped.includes(ORCA_GIT_COMMIT_TRAILER)) {
    return stripped
  }
  // Why: a blank line separates the trailer block from the body so `git
  // interpret-trailers` and most parsers treat it as a real trailer instead
  // of a paragraph continuation.
  return `${stripped}\n\n${ORCA_GIT_COMMIT_TRAILER}`
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

/**
 * Spawns the agent CLI in non-interactive mode, feeds the prompt via argv or
 * stdin per the plan, and returns the captured stdout. Always returns a
 * GenerateCommitMessageResult — never throws — so the IPC handler can
 * round-trip the failure to the renderer for inline display.
 */
async function runAgent(
  plan: CommitMessagePlan,
  cwd: string,
  attributionEnabled: boolean
): Promise<GenerateCommitMessageResult> {
  const { binary, args, stdinPayload, label } = plan
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

    if (stdinPayload !== null) {
      child.stdin?.end(stdinPayload)
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
  const planned = planCommitMessageGeneration(params, prompt)
  if (!planned.ok) {
    return { success: false, error: planned.error }
  }
  return runAgent(planned.plan, params.worktreePath, params.attributionEnabled === true)
}

/** Re-export so the IPC layer can validate agent ids at the boundary. */
export { COMMIT_MESSAGE_AGENT_SPECS }
