import type { CommandSpec } from '../args'
import { LOCAL_COMMAND_FLAGS } from '../args'

export const LOCAL_COMMAND_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['local-command', 'run'],
    summary: 'Ask the person to run one command on their own computer',
    usage:
      'orca local-command run "<command>" [--cwd <dir>] [--timeout <sec>] [--reason "<why>"] [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'command', 'cwd', 'timeout', 'reason'],
    positionalArgs: ['command'],
    notes: [
      "Works only in an Orca Cloud workspace, while the person's Orca app is open and they turned on Settings > Orca Cloud > Commands on this computer.",
      'The person sees the exact command and folder and approves each run. A denied or unanswered request exits 1.',
      '--cwd is an absolute folder on their computer, or ~/... (default: their home folder).',
      'Runs with /bin/sh in a minimal environment (PATH, HOME, locale), with no input. --timeout is 1-600 seconds (default 120).',
      'Output is cut at 128 KB per stream. Exits 1 when the command fails, times out, or is not approved.'
    ],
    examples: [
      'orca local-command run "xcrun simctl list devices booted" --reason "Find the simulator to test on"',
      'orca local-command run "security find-identity -p codesigning -v" --json'
    ]
  },
  {
    path: ['local-command', 'mcp'],
    summary: 'Serve the run_local_command tool over MCP (stdio) for agents',
    usage: 'orca local-command mcp',
    allowedFlags: [...LOCAL_COMMAND_FLAGS],
    notes: [
      'Orca Cloud registers this for Claude Code and Codex in every cloud workspace as the orca-local MCP server.'
    ]
  }
]
