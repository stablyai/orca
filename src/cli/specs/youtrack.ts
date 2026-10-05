import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const TARGET_FLAGS = ['id', 'current']

export const YOUTRACK_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['youtrack', 'issue'],
    summary: 'Read YouTrack issue context for agents',
    usage: 'orca youtrack issue [<id>] [--current] [--comments] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...TARGET_FLAGS, 'comments'],
    positionalArgs: ['id'],
    examples: [
      'orca youtrack issue PROJ-81',
      'orca youtrack issue --current --comments',
      'orca youtrack issue https://youtrack.example.com/issue/PROJ-81 --json'
    ]
  },
  {
    path: ['youtrack', 'list'],
    summary: 'List YouTrack issues by preset or query',
    usage:
      'orca youtrack list [--preset assigned|reported|open|done] [--query <youtrack query>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'preset', 'query', 'limit'],
    examples: [
      'orca youtrack list',
      'orca youtrack list --preset done --limit 10',
      'orca youtrack list --query "project: PROJ #Unresolved" --json'
    ]
  },
  {
    path: ['youtrack', 'comment', 'add'],
    summary: 'Add a comment to a YouTrack issue',
    usage:
      'orca youtrack comment add [<id>] [--current] (--body <markdown>|--body-file <path|->) [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...TARGET_FLAGS, 'body', 'body-file'],
    positionalArgs: ['id'],
    examples: [
      'orca youtrack comment add --current --body "Implemented retries; ready for review."',
      'orca youtrack comment add PROJ-81 --body-file notes.md'
    ]
  },
  {
    path: ['youtrack', 'state', 'set'],
    summary: 'Move a YouTrack issue to another state',
    usage: 'orca youtrack state set [<id>] [--current] --to <state> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...TARGET_FLAGS, 'to'],
    positionalArgs: ['id'],
    examples: [
      'orca youtrack state set --current --to "In Progress"',
      'orca youtrack state set PROJ-81 --to Fixed'
    ]
  },
  {
    path: ['youtrack', 'field', 'set'],
    summary: 'Set or clear a YouTrack issue field',
    usage:
      'orca youtrack field set [<id>] [--current] --name <field> (--value <value>...|--clear) [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...TARGET_FLAGS, 'name', 'value', 'clear'],
    repeatableFlags: ['value'],
    positionalArgs: ['id'],
    examples: [
      'orca youtrack field set --current --name Priority --value Major',
      'orca youtrack field set PROJ-81 --name "Estimation" --value "1d 4h"',
      'orca youtrack field set PROJ-81 --name Assignee --clear'
    ]
  },
  {
    path: ['youtrack', 'create'],
    summary: 'Create a YouTrack issue',
    usage:
      'orca youtrack create --project <key> --summary <text> [--body <markdown>|--body-file <path|->] [--field <name=value>...] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'project', 'summary', 'body', 'body-file', 'field'],
    repeatableFlags: ['field'],
    examples: [
      'orca youtrack create --project PROJ --summary "Flaky e2e on deploy" --field Type=Bug',
      'orca youtrack create --project PROJ --summary "Spike" --body-file spike.md --field Priority=Normal'
    ]
  }
]
