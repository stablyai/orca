import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'

const CLAIM_FLAGS = [...GLOBAL_FLAGS, 'id', 'as']
const EDIT_FLAGS = ['title', 'status', 'label', 'priority', 'depends-on']

export const LOCAL_TASKS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['local-tasks', 'list'],
    summary: 'List local tasks with status, readiness and priority',
    usage: 'orca local-tasks list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Tasks are Markdown files in ~/.orca/tasks (or ORCA_LOCAL_TASKS_DIR) on the host running Orca.'
    ],
    examples: ['orca local-tasks list --json']
  },
  {
    path: ['local-tasks', 'get'],
    summary: 'Read one local task',
    usage: 'orca local-tasks get <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    positionalArgs: ['id'],
    examples: ['orca local-tasks get fix-login --json']
  },
  {
    path: ['local-tasks', 'next'],
    summary: 'Pick the best ready tasks (priority, then oldest update)',
    usage: 'orca local-tasks next [--slots <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'slots'],
    examples: ['orca local-tasks next --slots 2 --json']
  },
  {
    path: ['local-tasks', 'claim'],
    summary: 'Claim a ready task and mark it working',
    usage: 'orca local-tasks claim <id> --as <name> [--json]',
    allowedFlags: CLAIM_FLAGS,
    positionalArgs: ['id'],
    notes: ['The claim is a 30 minute lease; call renew more often than that while working.'],
    examples: ['orca local-tasks claim fix-login --as my-agent --json']
  },
  {
    path: ['local-tasks', 'renew'],
    summary: 'Extend the lease on a task you hold',
    usage: 'orca local-tasks renew <id> --as <name> [--json]',
    allowedFlags: CLAIM_FLAGS,
    positionalArgs: ['id'],
    examples: ['orca local-tasks renew fix-login --as my-agent --json']
  },
  {
    path: ['local-tasks', 'release'],
    summary: 'Give a claimed task back to the queue',
    usage: 'orca local-tasks release <id> --as <name> [--json]',
    allowedFlags: CLAIM_FLAGS,
    positionalArgs: ['id'],
    examples: ['orca local-tasks release fix-login --as my-agent --json']
  },
  {
    path: ['local-tasks', 'create'],
    summary: 'Create a local task',
    usage:
      'orca local-tasks create --title <text> [--id <slug>] [--status <status>] [--label <name>...] [--priority <1-5>] [--depends-on <id>...] [--body <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...EDIT_FLAGS, 'id', 'body'],
    repeatableFlags: ['label', 'depends-on'],
    examples: ['orca local-tasks create --title "Fix login redirect" --priority 2 --json']
  },
  {
    path: ['local-tasks', 'update'],
    summary: 'Update fields of a local task',
    usage:
      'orca local-tasks update <id> [--title <text>] [--status <status>] [--label <name>...] [--priority <1-5>] [--depends-on <id>...] [--blocked-reason <text>] [--url <url>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...EDIT_FLAGS, 'id', 'blocked-reason', 'url'],
    positionalArgs: ['id'],
    repeatableFlags: ['label', 'depends-on'],
    notes: [
      'A repeated flag replaces the whole list. Statuses: todo, queued, working, in-progress, blocked, done, dropped, completed.'
    ],
    examples: ['orca local-tasks update fix-login --status done --json']
  }
]
