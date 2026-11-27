import { CLAUDE_PRE_TOOL_USE_DECISION } from '../../agent-hooks/tool-events/agent-tool-plugin-hooks'
import { CLAUDE_PERMISSION_REQUEST_DECISION } from '../../agent-hooks/server/claude-permission-hook-hold'

/** How long the POSIX script's PreToolUse curl waits for Orca's answer. */
export const CLAUDE_PRE_TOOL_USE_ANSWER_WAIT_SECONDS = 8

/**
 * Lets Claude Code's PreToolUse hook print Orca's answer (plugins' `agent.tool.before`), and its
 * PermissionRequest hook print a coordinator's or person's answer, instead of a fixed `{}`. Every
 * other event still prints `{}` before it posts. The answer is printed only when it is a decision
 * for that same event; a timeout, an error or no answer prints `{}`, so Claude asks as usual.
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
    `  *'"hook_event_name":"PreToolUse"'*|*'"hook_event_name": "PreToolUse"'*) orca_hook_decides=${CLAUDE_PRE_TOOL_USE_DECISION}; max_time=${CLAUDE_PRE_TOOL_USE_ANSWER_WAIT_SECONDS} ;;`,
    // Why 126 s: Orca answers within its 122 s hold; the managed entry's 130 s timeout outlasts both.
    // An async entry's output is ignored, so it answers `{}` first like any other event.
    `  *'"hook_event_name":"PermissionRequest"'*|*'"hook_event_name": "PermissionRequest"'*) if [ -n "\${ORCA_HOOK_ASYNC:-}" ]; then printf '{}\\n'; orca_hook_printed=1; else orca_hook_decides=${CLAUDE_PERMISSION_REQUEST_DECISION}; max_time=126; fi ;;`,
    "  *) printf '{}\\n'; orca_hook_printed=1 ;;",
    'esac'
  ]
}

/** Captures the post's reply; a failed curl's partial body is dropped, spooled and answered `{}`. */
export function wrapPosixClaudeDecisionPost(postLines: readonly string[]): string[] {
  return [
    // An event that asked for no decision discards the reply, so it skips the capture subshell.
    'if [ -z "$orca_hook_decides" ]; then',
    ...postLines.map((line, index) =>
      index === postLines.length - 1 ? `${line} >/dev/null 2>&1 || spool_hook_event` : line
    ),
    '  exit 0',
    'fi',
    ...postLines.map((line, index) =>
      index === 0
        ? `orca_hook_reply=$(${line}`
        : index === postLines.length - 1
          ? `${line} 2>/dev/null) || { orca_hook_reply=; spool_hook_event; }`
          : line
    ),
    // Only a decision for the event that asked is printed; anything else stays `{}`.
    'case "$orca_hook_decides:$orca_hook_reply" in',
    `  ${CLAUDE_PRE_TOOL_USE_DECISION}:'{"hookSpecificOutput":{"hookEventName":"PreToolUse"'*'}}') orca_hook_answer=$orca_hook_reply ;;`,
    `  ${CLAUDE_PERMISSION_REQUEST_DECISION}:'{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"'*'}}}') orca_hook_answer=$orca_hook_reply ;;`,
    'esac'
  ]
}
