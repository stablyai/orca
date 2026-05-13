import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ISSUE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['issue', 'create'],
    summary: 'Create a GitHub or Linear issue',
    usage:
      'orca issue create --provider github --repo <selector> --title <title> --body <text> [--json]\n' +
      'orca issue create --provider linear --team <team-id> --title <title> --body <text> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'provider', 'repo', 'team', 'title', 'body'],
    notes: [
      'GitHub issue creation requires a registered Git repo selector.',
      'Linear issue creation requires a Linear team ID and an active Linear connection.',
      '--body is required and is used as the GitHub body or Linear description.'
    ],
    examples: [
      'orca issue create --provider github --repo id:repo-1 --title "Bug found" --body "Steps to reproduce..." --json',
      'orca issue create --provider linear --team team-id --title "Follow up" --body "Context..." --json'
    ]
  }
]
