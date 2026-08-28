import { buildPosixAgentHookPostCommand } from '../agent-hooks/hook-post-command'
import {
  buildPosixHookPayloadCapture,
  buildPosixHookSpoolLines
} from '../agent-hooks/hook-stdin-contract'

/** The POSIX managed hook Orca installs into Claude.
 *
 *  Extracted from the service so the enforcement half has room to be readable:
 *  this script is now a decision point, not just a status post. It reads Orca's
 *  reply to PreToolUse and refuses the tool call when the workspace is under
 *  someone else's validation lease, and it falls back to a durable on-disk
 *  sentinel when Orca cannot answer at all.
 */
export function buildClaudePosixHookScript(
  options: { skipWhenDevinImportsClaude?: boolean } = {}
): string {
  return [
    '#!/bin/sh',
    // Why: Claude-compatible permission hooks fail closed on empty stdout (#14818).
    'printf "{}\\n"',
    ...buildPosixHookPayloadCapture(),
    ...buildPosixHookSpoolLines('claude'),
    ...(options.skipWhenDevinImportsClaude
      ? [
          // Why: Devin imports .claude hooks by default; skip Orca's managed hook there so status posts stay attributed to Devin.
          'if [ -n "$DEVIN_PROJECT_DIR" ]; then',
          '  exit 0',
          'fi'
        ]
      : []),
    // Why: a backgrounded session runs in a daemon worker that inherited the dispatching
    // pane's env, so ORCA_PANE_KEY names a pane this session does not run in (#9236).
    'if [ -n "$CLAUDE_JOB_DIR" ]; then',
    '  exit 0',
    'fi',
    // Why: refresh endpoint coordinates for PTYs surviving an Orca restart.
    // Why: suppress parse errors so they neither leak nor trip outer set -e.
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  unset ORCA_AGENT_HOOK_TRANSPORT',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    // Why a function defined before every early exit: "Orca is not running at
    // all" is exactly when the durable sentinel is the only fence left, and the
    // guard below returns long before the POST is ever attempted. Checking only
    // after a failed POST would leave the no-endpoint path wide open.
    'orca_fence_denies() {',
    '  [ -n "${ORCA_AGENT_HOOK_ENDPOINT:-}" ] || return 0',
    '  case "$payload" in *PreToolUse*) ;; *) return 0 ;; esac',
    '  [ -n "${ORCA_WORKTREE_ID:-}" ] || return 0',
    '  orca_fence_dir="${ORCA_AGENT_HOOK_ENDPOINT%/*}/fence"',
    // The prefix must match fenceKeyFor() byte for byte: a transform that
    // disagreed would miss the sentinel and allow the mutation.
    "  orca_fence_key=$(printf %s \"$ORCA_WORKTREE_ID\" | tail -c 64 | tr -c 'A-Za-z0-9._-' '_')",
    '  [ -n "$orca_fence_key" ] || return 0',
    '  orca_fence_now=$(date +%s 2>/dev/null || printf 0)',
    // One file per LEASE: the prefix is lossy, so two colliding workspaces each
    // keep their own marker instead of overwriting one shared file. Every
    // candidate is scanned and the exact worktree id decides which one applies.
    '  for orca_fence_file in "$orca_fence_dir/$orca_fence_key".*.fence; do',
    '    [ -f "$orca_fence_file" ] || continue',
    '    orca_fence_marked=$(sed -n \'1p\' "$orca_fence_file" 2>/dev/null)',
    '    [ "$orca_fence_marked" = "$ORCA_WORKTREE_ID" ] || continue',
    // An orphaned marker must stop denying on its own rather than wedge the
    // workspace forever.
    '    orca_fence_expiry=$(sed -n \'2p\' "$orca_fence_file" 2>/dev/null)',
    '    case "$orca_fence_expiry" in \'\' | *[!0-9]*) continue ;; esac',
    '    [ "$orca_fence_expiry" -gt "$orca_fence_now" ] || continue',
    "    printf 'Orca is unreachable and a validation lease is active on this workspace; refusing to mutate it.\\n' >&2",
    '    exit 2',
    '  done',
    '}',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  spool_hook_event',
    '  orca_fence_denies',
    '  exit 0',
    'fi',
    // Why: keep full hook JSON off the command line and avoid IDS-friendly URL-encoded paths.
    // Why the reply is captured rather than discarded: PreToolUse is the only
    // synchronous point before the tool runs, and Orca answers it with Claude's
    // own deny contract when this worktree is under someone else's validation
    // lease. Piping it to /dev/null — as this did — is what made the hook pure
    // telemetry and let a running worker edit a tree a gate was using.
    'orca_hook_reply=$(',
    ...buildPosixAgentHookPostCommand('claude').map((line, index, lines) =>
      index === lines.length - 1 ? `${line} 2>/dev/null` : line
    ),
    ') || orca_hook_unreachable=1',
    // Why a file and not a retry: if Orca cannot answer, the live fence is gone,
    // and on a worktree with a gate running that must read as DENY rather than
    // as permission. A lease drops this sentinel exactly so the decision
    // survives the runtime. It can only ever add a denial.
    'if [ -n "${orca_hook_unreachable:-}" ]; then',
    '  spool_hook_event',
    '  orca_fence_denies',
    '  exit 0',
    'fi',
    'case "$orca_hook_reply" in',
    '  *permissionDecision*deny*)',
    '    printf \'%s\\n\' "$orca_hook_reply" >&2',
    '    exit 2',
    '    ;;',
    'esac',
    'exit 0',
    ''
  ].join('\n')
}
