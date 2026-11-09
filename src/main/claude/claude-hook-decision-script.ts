import { CLAUDE_PRE_TOOL_USE_DECISION } from '../agent-hooks/tool-events/agent-tool-plugin-hooks'
import {
  CLAUDE_MEMORY_PERMISSION_ALLOW,
  CLAUDE_MEMORY_PERMISSION_DECISION
} from './claude-profile-memory-permission'

/**
 * Lets Claude Code's PreToolUse hook print Orca's answer (plugins' `agent.tool.before`) instead of
 * a fixed `{}`. A PermissionRequest for a shared auto-memory file waits for one exact allow.
 * Every other event still prints `{}` before it posts, as permission hooks need. The answer is
 * printed only when it is one of those decisions; a timeout, an error or no answer prints `{}`.
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
    `  *'"hook_event_name":"PermissionRequest"'*|*'"hook_event_name": "PermissionRequest"'*)`,
    '    case "$payload" in',
    `      *'"tool_name":"Write"'*|*'"tool_name": "Write"'*|*'"tool_name":"Edit"'*|*'"tool_name": "Edit"'*|*'"tool_name":"MultiEdit"'*|*'"tool_name": "MultiEdit"'*)`,
    '        case "$payload" in',
    `          *'/memory/'*) orca_hook_decides=${CLAUDE_MEMORY_PERMISSION_DECISION}; max_time=8 ;;`,
    "          *) printf '{}\\n'; orca_hook_printed=1 ;;",
    '        esac ;;',
    "      *) printf '{}\\n'; orca_hook_printed=1 ;;",
    '    esac ;;',
    "  *) printf '{}\\n'; orca_hook_printed=1 ;;",
    'esac'
  ]
}

/** Captures the post's reply; a failed curl's partial body is dropped, spooled and answered `{}`. */
export function wrapPosixClaudeDecisionPost(postLines: readonly string[]): string[] {
  return [
    ...postLines.map((line, index) =>
      index === 0
        ? `orca_hook_reply=$(${line}`
        : index === postLines.length - 1
          ? `${line} 2>/dev/null) || { orca_hook_reply=; spool_hook_event; }`
          : line
    ),
    'case "$orca_hook_reply" in',
    '  \'{"hookSpecificOutput":{"hookEventName":"PreToolUse"\'*\'}}\')',
    `    [ "$orca_hook_decides" = ${CLAUDE_PRE_TOOL_USE_DECISION} ] && orca_hook_answer=$orca_hook_reply ;;`,
    `  '${CLAUDE_MEMORY_PERMISSION_ALLOW}')`,
    `    [ "$orca_hook_decides" = ${CLAUDE_MEMORY_PERMISSION_DECISION} ] && orca_hook_answer=$orca_hook_reply ;;`,
    'esac'
  ]
}
