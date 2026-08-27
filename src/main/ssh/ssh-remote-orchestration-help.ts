import type { ParsedRemoteCli } from './ssh-remote-cli-argument-error'

const ORCHESTRATION_CHECK_HELP = `orca orchestration check

Usage: orca orchestration check [--terminal <handle>] [--run <run_id>] [--ack <delivery_id>] [--unread | --peek | --all] [--types <type,...>] [--format] [--wait] [--timeout-ms <n>] [--json]
  default: return the bound Run's oldest unacknowledged FIFO batch.
  --ack: acknowledge the prior whole batch before checking/waiting.
  --peek: return only unread messages without marking them read.
  --all: return every message for the handle; does not mark read.
  --wait: block until a matching message arrives or --timeout-ms expires.
          Emits JSON keepalive lines to stderr every 15s so the caller can
          tell the process is alive. \`_keepalive\` is unrelated to heartbeat
          messages; \`_heartbeat\` remains as a deprecated compatibility alias.
          Filter with \`jq "select(._keepalive|not)"\` when merging streams.

Check messages for a terminal

Options:
  --help                 Show this help message
  --json                 Emit machine-readable JSON
  --pairing-code
  --environment
  --terminal <handle>  Runtime-issued terminal handle
  --run <run_id>
  --ack <delivery_id>
  --unread
  --peek
  --all
  --types <type,...>
  --format               Render returned rows as local text
  --wait
  --timeout-ms <ms>     Maximum wait time before timing out
  --retry-request

Notes:
  On Windows PowerShell, quote comma-separated type filters, e.g. --types "worker_done,escalation".
  --format renders the returned rows as local text only; it never writes to another terminal.
  A bound Run replays the same Delivery until --ack; process every message before acknowledging.`

export function getRemoteOrchestrationHelp(parsed: ParsedRemoteCli): string | null {
  if (!parsed.flags.has('help') || parsed.commandPath.join(' ') !== 'orchestration check') {
    return null
  }
  return ORCHESTRATION_CHECK_HELP
}
