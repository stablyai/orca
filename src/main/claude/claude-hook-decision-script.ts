import { CLAUDE_PRE_TOOL_USE_DECISION } from '../agent-hooks/agent-tool-plugin-hooks'

/**
 * Lets Claude Code's PreToolUse hook print Orca's answer (plugins' `agent.tool.before`) instead of
 * a fixed `{}`. Every other event still prints `{}` before it posts, as permission hooks need. The
 * answer is printed only when it is a PreToolUse decision; a timeout, an error or no answer prints
 * `{}`, so the tool call proceeds as if Orca were not there.
 */
export function buildPosixClaudeDecisionPreludeLines(): string[] {
  return [
    'orca_hook_printed=',
    'orca_hook_answer=',
    'orca_hook_decides=',
    // An early exit (a skip path) still prints the `{}` Claude Code needs.
    'orca_hook_finish() {',
    '  [ -z "$orca_hook_printed" ] || return 0',
    '  if [ -n "$orca_hook_answer" ]; then printf \'%s\\n\' "$orca_hook_answer"; else printf \'{}\\n\'; fi',
    '}',
    'trap orca_hook_finish EXIT'
  ]
}

export function buildPosixClaudeDecisionModeLines(): string[] {
  return [
    'case "$payload" in',
    `  *'"hook_event_name":"PreToolUse"'*|*'"hook_event_name": "PreToolUse"'*) orca_hook_decides=${CLAUDE_PRE_TOOL_USE_DECISION}; max_time=8 ;;`,
    "  *) printf '{}\\n'; orca_hook_printed=1 ;;",
    'esac'
  ]
}

/** Captures the post's reply; failures spool as before and fall back to `{}`. */
export function wrapPosixClaudeDecisionPost(postLines: readonly string[]): string[] {
  return [
    ...postLines.map((line, index) =>
      index === 0
        ? `orca_hook_reply=$(${line}`
        : index === postLines.length - 1
          ? `${line} 2>/dev/null) || spool_hook_event`
          : line
    ),
    'case "$orca_hook_reply" in \'{"hookSpecificOutput":{"hookEventName":"PreToolUse"\'*) orca_hook_answer=$orca_hook_reply ;; esac'
  ]
}
