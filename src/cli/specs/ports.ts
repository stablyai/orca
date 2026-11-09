import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const PORTS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['ports'],
    summary: 'List the listening ports Orca detected for a workspace',
    usage: 'orca ports [--worktree <selector>] [--all] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'all'],
    notes: [
      'Defaults to the Orca workspace that contains the current directory.',
      'Scans the host the workspace runs on and lists the ports Orca tied to it, by process working directory (match=cwd) or command line (match=command).',
      '--all lists every listener found on that host, including other workspaces and processes Orca could not tie to one. A native folder workspace needs --all, because Orca does not tie ports to folders.',
      'url is the address the dev server printed in an Orca terminal; it is missing when Orca did not see one.'
    ],
    examples: [
      'orca ports',
      'orca ports --worktree branch:feature/login --json',
      'orca ports --all',
      "orca ports --json | jq -r '.result.ports[0].advertisedUrl'"
    ]
  }
]
