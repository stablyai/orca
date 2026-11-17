import {
  claudeRecord,
  claudeText,
  claudeToolResults,
  claudeToolUses,
  type ClaudeMessageEnvelope
} from './claude-structured-item-translation'

type WorktreeCall = { name: 'EnterWorktree' | 'ExitWorktree'; input: unknown }

// Claude Code's worktree folder; the path before it may hold spaces (`/Users/Jane Doe/...`).
const WORKTREE_MARKER = /[\\/]\.claude[\\/]worktrees[\\/][A-Za-z0-9._\-\\/]+/
// An absolute path start (POSIX, drive or UNC) at a line start or after whitespace, a quote or `(`.
const PATH_START = /(?<=^|[\s'"`(])(?:[A-Za-z]:)?[\\/]/gm

/** The absolute worktree path named in tool output: the marker plus its nearest path start. */
function worktreePathInText(output: string): string | null {
  const marker = WORKTREE_MARKER.exec(output)
  if (!marker) {
    return null
  }
  const start = [...output.slice(0, marker.index).matchAll(PATH_START)].at(-1)?.index
  if (start === undefined) {
    return null
  }
  return output.slice(start, marker.index + marker[0].length).replace(/[.,;:)]+$/, '')
}

function isAbsoluteHostPath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

function absolutePath(value: unknown): string | null {
  const text = claudeText(value)?.trim()
  return text && isAbsoluteHostPath(text) ? text : null
}

/** Where EnterWorktree switched the session: its structured result, the path in its text, then its input. */
function enteredWorktree(input: unknown, output: string, structured: unknown): string | null {
  const result = claudeRecord(structured)
  const fromResult =
    absolutePath(result?.worktreePath) ??
    absolutePath(result?.worktree_path) ??
    absolutePath(result?.path)
  if (fromResult) {
    return fromResult
  }
  return worktreePathInText(output) ?? absolutePath(claudeRecord(input)?.path)
}

/**
 * The root session's working directory after EnterWorktree / ExitWorktree. Undefined means the
 * launch directory: the CLI starts every process there, so a restart rightly forgets a switch.
 */
export class ClaudeWorkingDirectory {
  private readonly calls = new Map<string, WorktreeCall>()
  current: string | undefined

  /** Call before the frame is journaled so the published status already carries the move. */
  observe(envelope: ClaudeMessageEnvelope, frame: Record<string, unknown>): void {
    // A subagent's switch moves only that agent, never the chat's own working directory.
    if (envelope.parentToolUseId !== null) {
      return
    }
    for (const use of claudeToolUses(envelope)) {
      if (use.name === 'EnterWorktree' || use.name === 'ExitWorktree') {
        this.calls.set(use.id, { name: use.name, input: use.input })
      }
    }
    for (const result of claudeToolResults(envelope)) {
      const call = this.calls.get(result.toolUseId)
      if (!call) {
        continue
      }
      this.calls.delete(result.toolUseId)
      if (result.failed) {
        continue
      }
      if (call.name === 'ExitWorktree') {
        this.current = undefined
        continue
      }
      this.current =
        enteredWorktree(call.input, result.output, frame.tool_use_result) ?? this.current
    }
  }
}
