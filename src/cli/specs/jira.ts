import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const JIRA_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['jira', 'status'],
    summary: 'Show Jira sites connected to the selected Orca runtime',
    usage: 'orca jira status [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: ['Uses the Jira connection in Orca settings, not an agent MCP login.']
  },
  ...['issue', 'comments'].map((command): CommandSpec => ({
    path: ['jira', command],
    summary: command === 'issue' ? 'Read a Jira issue' : 'Read Jira issue comments',
    usage: `orca jira ${command} <key-or-url> [--site <site-id>] [--json]`,
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'site'],
    positionalArgs: ['id'],
    examples: [`orca jira ${command} https://example.atlassian.net/browse/ENG-123 --json`],
    notes: [
      'Uses the Jira connection in Orca settings, not an agent MCP login.',
      'A URL selects its matching connected site. With multiple sites, a bare key requires --site.',
      ...(command === 'comments'
        ? [
            'An empty result exits with jira_comments_unverified: the runtime also returns empty results on read failures.'
          ]
        : [])
    ]
  }))
]
