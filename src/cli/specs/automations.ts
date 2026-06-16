import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const AUTOMATION_TARGET_FLAGS = [
  'repo',
  'workspace',
  'project',
  'host',
  'project-host-setup',
  'source-context',
  'workspace-mode',
  'base-branch'
]
const AUTOMATION_SCHEDULE_FLAGS = ['trigger', 'schedule', 'time', 'day', 'timezone']
const AUTOMATION_PRECHECK_FLAGS = ['precheck', 'precheck-timeout']
const AUTOMATION_STATE_FLAGS = [
  'enabled',
  'disabled',
  'missed-run-grace-minutes',
  'reuse-session',
  'fresh-session'
]
// Assign an automation to a folder by name (resolved, create-on-miss via
// --create-folder) or by exact id; shared by create and edit.
const AUTOMATION_FOLDER_FLAGS = ['folder', 'folder-id', 'create-folder']
const AUTOMATION_LIST_FILTER_FLAGS = ['status', 'folder', 'folder-id', 'last-run', 'search']

export const AUTOMATION_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['automations', 'list'],
    summary: 'List scheduled Orca automations',
    usage:
      'orca automations list [--status <enabled|paused|all>] [--folder <name>|--folder-id <id>] [--last-run <completed|failed|skipped|any>] [--search <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...AUTOMATION_LIST_FILTER_FLAGS],
    notes: [
      'Filters AND-compose: an automation is shown only when it matches every flag you pass.',
      '--status defaults to all; --last-run defaults to any. Both use the same buckets as the Orca UI.',
      'Use --folder <name> to filter by a folder name, or --folder-id <id> for an exact match; --folder-id "" or --folder-id null selects unfiled automations.',
      '--search matches a substring of the automation name or prompt (case-insensitive).',
      '--json adds folderId to each automation and a top-level folders array so scripts can render the folder tree.'
    ],
    examples: [
      'orca automations list',
      'orca automations list --status paused --last-run failed',
      'orca automations list --folder "Release" --search nightly',
      'orca automations list --json'
    ]
  },
  {
    path: ['automations', 'show'],
    summary: 'Show one Orca automation',
    usage: 'orca automations show <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    positionalArgs: ['id'],
    examples: ['orca automations show 2f9e...', 'orca automations show --id 2f9e... --json']
  },
  {
    path: ['automations', 'create'],
    summary: 'Create a scheduled Orca automation',
    usage:
      'orca automations create --name <name> --trigger <preset|cron|rrule> --prompt <text> --provider <agent> [--precheck <command>] [--repo <selector>|--workspace <selector>|--project <id> [--host <id>]|--project-host-setup <id>] [--folder <name> [--create-folder]|--folder-id <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'name',
      'prompt',
      'provider',
      ...AUTOMATION_PRECHECK_FLAGS,
      ...AUTOMATION_TARGET_FLAGS,
      ...AUTOMATION_SCHEDULE_FLAGS,
      ...AUTOMATION_STATE_FLAGS,
      ...AUTOMATION_FOLDER_FLAGS
    ],
    notes: [
      'Trigger accepts hourly, daily, weekdays, weekly, a 5-field cron expression, or an RRULE string.',
      'When --repo is omitted, the CLI uses the enclosing Orca worktree when one can be resolved from cwd.',
      'Use --project with --host, or --project-host-setup, to run on a specific project host setup.',
      'Use --source-context with a JSON TaskSourceContext when task/provider data should come from a specific host/account; pass null on edit to clear it.',
      'Use --workspace to run in an existing worktree; otherwise the automation creates a new worktree per run.',
      'Use --precheck to run a bounded command before scheduled runs; exit code 0 continues, anything else records a skipped run.',
      'Use --reuse-session only with existing-workspace automations to submit later runs to the previous live automation session when it is still available. Use --fresh-session to disable reuse.',
      'Use --folder <name> to file the automation under an existing folder; pass --create-folder to create it when no folder matches that name. Use --folder-id <id> for an exact folder match.'
    ],
    examples: [
      'orca automations create --name "Daily review" --trigger daily --prompt "Review open changes" --provider codex',
      'orca automations create --name "Weekday triage" --trigger "0 9 * * 1-5" --prompt "Triage issues" --provider claude --repo my-repo',
      'orca automations create --name "PR review" --trigger hourly --precheck "gh pr list --json number -q .[0].number" --prompt "Review requested PRs" --provider codex',
      'orca automations create --name "Nightly" --trigger daily --prompt "Run checks" --provider codex --folder "Release" --create-folder'
    ]
  },
  {
    path: ['automations', 'edit'],
    summary: 'Edit an Orca automation',
    usage:
      'orca automations edit <id> [--name <name>] [--trigger <preset|cron|rrule>] [--folder <name> [--create-folder]|--folder-id <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'id',
      'name',
      'prompt',
      'provider',
      ...AUTOMATION_PRECHECK_FLAGS,
      ...AUTOMATION_TARGET_FLAGS,
      ...AUTOMATION_SCHEDULE_FLAGS,
      ...AUTOMATION_STATE_FLAGS,
      ...AUTOMATION_FOLDER_FLAGS
    ],
    positionalArgs: ['id'],
    notes: [
      'Use --folder <name> (optionally with --create-folder) or --folder-id <id> to move the automation into a folder. Prefer `orca automations move` when only changing the folder.'
    ],
    examples: [
      'orca automations edit 2f9e... --disabled',
      'orca automations edit --id 2f9e... --trigger "30 * * * *" --json',
      'orca automations edit 2f9e... --folder "Release"'
    ]
  },
  {
    path: ['automations', 'move'],
    summary: 'Move an automation into a folder, or unfile it',
    usage: 'orca automations move <id> --folder <name>|--folder-id <id>|--unfile [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'folder', 'folder-id', 'create-folder', 'unfile'],
    positionalArgs: ['id'],
    notes: [
      'Pass exactly one of --folder, --folder-id, or --unfile.',
      'Use --folder <name> to resolve a folder by name; add --create-folder to create it when no folder matches.',
      'Use --folder-id <id> for an exact folder, or --unfile to clear the folder (folderId null).'
    ],
    examples: [
      'orca automations move 2f9e... --folder "Release"',
      'orca automations move 2f9e... --folder-id fld_123',
      'orca automations move 2f9e... --unfile'
    ]
  },
  {
    path: ['automations', 'remove'],
    summary: 'Remove an Orca automation and its run history',
    usage: 'orca automations remove <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    positionalArgs: ['id'],
    examples: ['orca automations remove 2f9e...', 'orca automations remove --id 2f9e... --json']
  },
  {
    path: ['automations', 'run'],
    summary: 'Run an Orca automation now',
    usage: 'orca automations run <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    positionalArgs: ['id'],
    examples: ['orca automations run 2f9e...', 'orca automations run --id 2f9e... --json']
  },
  {
    path: ['automations', 'runs'],
    summary: 'List automation run history',
    usage: 'orca automations runs [--id <automation-id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    examples: ['orca automations runs', 'orca automations runs --id 2f9e... --json']
  },
  {
    path: ['automations', 'folders', 'list'],
    summary: 'List automation folders',
    usage: 'orca automations folders list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Folders are listed by sort order, then name. --json includes parent and color fields.'
    ],
    examples: ['orca automations folders list', 'orca automations folders list --json']
  },
  {
    path: ['automations', 'folders', 'create'],
    summary: 'Create an automation folder',
    usage:
      'orca automations folders create --name <name> [--color <token>] [--parent <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name', 'color', 'parent'],
    notes: [
      'Use --color with a design-token name to tint the folder, and --parent <id> to nest it under another folder.'
    ],
    examples: [
      'orca automations folders create --name "Release"',
      'orca automations folders create --name "Nightly" --color blue --parent fld_release'
    ]
  },
  {
    path: ['automations', 'folders', 'rename'],
    summary: 'Rename an automation folder',
    usage: 'orca automations folders rename <id> --name <name> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'name'],
    positionalArgs: ['id'],
    examples: ['orca automations folders rename fld_123 --name "Releases"']
  },
  {
    path: ['automations', 'folders', 'delete'],
    summary: 'Delete an automation folder',
    usage: 'orca automations folders delete <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    positionalArgs: ['id'],
    notes: [
      'Deleting a folder never deletes its automations; they revert to unfiled. The output reports how many were unfiled.'
    ],
    examples: [
      'orca automations folders delete fld_123',
      'orca automations folders delete --id fld_123 --json'
    ]
  }
]
