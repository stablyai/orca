import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const BRIDGE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['bridge', 'list'],
    summary: 'List terminals in the current worktree with @targets for cross-terminal interaction',
    usage: 'orca bridge list [--worktree <selector>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'limit']
  },
  {
    path: ['bridge', 'id'],
    summary: 'Print the current terminal target (e.g. @1)',
    usage: 'orca bridge id [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['bridge', 'resolve'],
    summary: 'Resolve a terminal target (@1, @label) to a runtime handle',
    usage: 'orca bridge resolve <target> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'target'],
    positionalArgs: ['target']
  },
  {
    path: ['bridge', 'read'],
    summary:
      'Read recent output from a target terminal with human-readable formatting and optional fast-jev compaction',
    usage: 'orca bridge read <target> [lines] [--screen] [--compact] [--raw] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'target', 'screen', 'compact', 'raw'],
    positionalArgs: ['target', 'lines']
  },
  {
    path: ['bridge', 'type'],
    summary: 'Type text into a target terminal without pressing Enter',
    usage: 'orca bridge type <target> <text> [--no-read-guard] [--force] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'target', 'text', 'no-read-guard', 'force'],
    positionalArgs: ['target', 'text']
  },
  {
    path: ['bridge', 'send'],
    summary: 'Send text into a target terminal and press Enter',
    usage: 'orca bridge send <target> <text> [--no-read-guard] [--force] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'target', 'text', 'no-read-guard', 'force'],
    positionalArgs: ['target', 'text']
  },
  {
    path: ['bridge', 'message'],
    aliases: [['bridge', 'msg']],
    summary: 'Send a formatted message with sender header to a target terminal',
    usage: 'orca bridge message <target> <message> [--no-read-guard] [--force] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'target', 'message', 'no-read-guard', 'force'],
    positionalArgs: ['target', 'message']
  },
  {
    path: ['bridge', 'keys'],
    summary: 'Send special keys to a target terminal (Enter, Escape, C-c, etc.)',
    usage: 'orca bridge keys <target> <key>... [--no-read-guard] [--force] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'target', 'no-read-guard', 'force'],
    positionalArgs: ['target', 'key']
  },
  {
    path: ['bridge', 'name'],
    summary: 'Label or rename a target terminal for addressing',
    usage: 'orca bridge name <target> <name> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'target', 'name'],
    positionalArgs: ['target', 'name']
  },
  {
    path: ['bridge', 'doctor'],
    summary: 'Diagnose Orca terminal bridge environment and connectivity',
    usage: 'orca bridge doctor [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['bridge', 'trace'],
    summary: 'Emit an A2A communication trace link between terminals for UI visualization',
    usage:
      'orca bridge trace <target> [text] [--from <sender>] [--type <send|message|type|keys>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'target', 'text', 'from', 'type'],
    positionalArgs: ['target', 'text']
  }
]
