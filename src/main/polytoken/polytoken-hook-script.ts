import { buildPosixAgentHookPostCommand } from '../agent-hooks/hook-post-command'
import {
  buildPosixHookSpoolLines,
  POSIX_HOOK_STDIN_DRAIN_COMMAND
} from '../agent-hooks/hook-stdin-contract'
import { getSharedManagedScriptPath, wrapPosixHookCommand } from '../agent-hooks/installer-utils'

// Why: must keep the `polytoken-` stem so the shared refresher coverage test and the
// managed-command matcher recognize it.
export const POLYTOKEN_MANAGED_SCRIPT_FILE_NAME = 'polytoken-hook.sh'

export function getPolytokenManagedScriptPath(): string {
  return getSharedManagedScriptPath(POLYTOKEN_MANAGED_SCRIPT_FILE_NAME)
}

// Why: Polytoken runs the handler through `bash` on every host; forward slashes keep a
// Windows-hosted WSL path readable. The default fallback drains stdin and prints nothing,
// which is Polytoken's documented proceed outcome, and the pane-key guard means sessions
// Orca did not launch never spawn the script at all.
export function getPolytokenManagedCommand(scriptPath: string): string {
  const posixPath = process.platform === 'win32' ? scriptPath.replaceAll('\\', '/') : scriptPath
  return wrapPosixHookCommand(posixPath, {}, { requiredEnvVar: 'ORCA_PANE_KEY' })
}

// Why: hooks on `pre_model_turn`, `pre_tool_use` and `stop` fail closed, and "exit 0 with no
// output" is the proceed outcome for every event, so this script never prints to stdout and
// always exits 0. Session id, model and event name arrive only through the environment;
// they are charset-checked and spliced into the JSON object so the receiver keeps its
// generic envelope and the payload's own fields (e.g. session_start's session_id) win.
export function getPolytokenManagedScript(): string {
  return [
    '#!/bin/sh',
    'payload=$({ command -p head -c 262144 2>/dev/null || head -c 262144; } 2>/dev/null)',
    `${POSIX_HOOK_STDIN_DRAIN_COMMAND}`,
    'if [ -z "$payload" ]; then payload=\'{}\'; fi',
    'polytoken_hook_event="${POLYTOKEN_HOOK_EVENT:-}"',
    'polytoken_meta_safe() { case "$1" in \'\'|*[!A-Za-z0-9._@/:+-]*) return 1 ;; esac; [ "${#1}" -le 128 ]; }',
    "polytoken_meta=''",
    'if polytoken_meta_safe "$polytoken_hook_event"; then polytoken_meta="$polytoken_meta\\"hook_event_name\\":\\"$polytoken_hook_event\\","; fi',
    'if polytoken_meta_safe "${POLYTOKEN_SESSION_ID:-}"; then polytoken_meta="$polytoken_meta\\"session_id\\":\\"$POLYTOKEN_SESSION_ID\\","; fi',
    'if polytoken_meta_safe "${POLYTOKEN_MODEL_NAME:-}"; then polytoken_meta="$polytoken_meta\\"model_name\\":\\"$POLYTOKEN_MODEL_NAME\\","; fi',
    'payload="${payload#"${payload%%[![:space:]]*}"}"',
    'case "$payload" in',
    "  '{'*)",
    '    if [ -n "$polytoken_meta" ]; then',
    '      polytoken_rest="${payload#\\{}"',
    '      polytoken_rest="${polytoken_rest#"${polytoken_rest%%[![:space:]]*}"}"',
    '      case "$polytoken_rest" in',
    '        \'}\'*) payload="{${polytoken_meta%,}$polytoken_rest" ;;',
    '        *) payload="{$polytoken_meta$polytoken_rest" ;;',
    '      esac',
    '    fi',
    '    ;;',
    'esac',
    ...buildPosixHookSpoolLines('polytoken', 'polytoken_hook_event'),
    // Why: tool events are high-volume and only ever say "working"; replaying them later adds nothing.
    'polytoken_spool_hook_event() {',
    '  case "$polytoken_hook_event" in pre_tool_use|post_tool_use|post_tool_use_failure) return 0 ;; esac',
    '  spool_hook_event',
    '}',
    // Why: refresh PORT/TOKEN/ENV/VERSION from the current Orca install so a PTY that survived
    // an Orca restart still reaches the live listener (see claude/hook-service.ts).
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  polytoken_spool_hook_event',
    '  exit 0',
    'fi',
    ...buildPosixAgentHookPostCommand('polytoken').map((line, index, lines) =>
      index === lines.length - 1 ? `${line} >/dev/null 2>&1 || polytoken_spool_hook_event` : line
    ),
    'exit 0',
    ''
  ].join('\n')
}
