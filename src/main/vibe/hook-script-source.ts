import { buildPosixAgentHookPostCommand } from '../agent-hooks/hook-post-command'
import {
  buildPosixHookPayloadCapture,
  buildPosixHookSpoolLines
} from '../agent-hooks/hook-stdin-contract'

// The managed POSIX launcher Vibe's hook runner invokes. Vibe spawns hook
// commands via asyncio.create_subprocess_shell (POSIX /bin/sh on macOS/Linux),
// so a single curl-based script body covers the supported platforms. Windows
// is not yet supported (see VIBE_INTEGRATION.md).
//
// Orca is a read-only observer: the script always exits 0 with empty stdout so
// it never produces a Vibe hook decision (allow/deny/rewrite). The default
// 'exit' payload-capture policy (exit 0 on empty stdin) is correct here — NOT
// Claude's 'empty-object' policy, which would print `{}` and Vibe would parse
// as a (no-op) decision.
export function getVibeManagedScript(): string {
  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture(),
    ...buildPosixHookSpoolLines('mistral-vibe'),
    // Why: refresh PORT/TOKEN/ENV/VERSION from the current Orca install so a PTY
    // that survived an Orca restart still reaches the live listener.
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  spool_hook_event',
    '  exit 0',
    'fi',
    'post_vibe_hook() {',
    '  curl_bin="$1"',
    '  connect_timeout="${2:-0.5}"',
    '  max_time="${3:-1.5}"',
    // Why: keep full hook JSON off the command line and let the receiver parse
    // metadata from headers — same transport as every other agent.
    ...buildPosixAgentHookPostCommand('mistral-vibe', {
      curlCommand: '"$curl_bin"',
      indent: '    '
    }).map((line) => `  ${line}`),
    '}',
    'if post_vibe_hook curl >/dev/null 2>&1; then',
    '  exit 0',
    'fi',
    'spool_hook_event',
    'exit 0',
    ''
  ].join('\n')
}
