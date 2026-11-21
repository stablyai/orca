import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'

export const REPO_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['repo', 'list'],
    summary: 'List repos registered in Orca',
    usage: 'orca repo list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['repo', 'add'],
    summary: 'Add a project to Orca by filesystem path',
    usage: 'orca repo add --path <path> [--kind git|folder] [--project-group <id|name>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'path', 'kind', 'project-group'],
    notes: [
      'Defaults to git. Use --kind folder for an ordinary directory, including a parent of separate Git repositories; worktrees attached to a folder workspace appear in its Source Control panel, one section each.',
      'With --environment, --path must be an absolute path on that Orca server.',
      '--project-group puts the repo into that sidebar project group; see `orca repo group list`.'
    ],
    examples: [
      'orca repo add --path /abs/path/to/folder --kind folder --json',
      'orca repo add --path /abs/path/to/repo --project-group Work --json'
    ]
  },
  {
    path: ['repo', 'show'],
    summary: 'Show one registered repo',
    usage: 'orca repo show --repo <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo']
  },
  {
    path: ['repo', 'set'],
    summary: "Set a repo's non-Orca worktree visibility, browser profile or project group",
    usage:
      'orca repo set --repo <selector> [--external-worktree-visibility show|hide|inherit] [--browser-profile <id>|inherit] [--project-group <id|name|none>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'repo',
      'external-worktree-visibility',
      'browser-profile',
      'project-group'
    ],
    notes: [
      'Pass at least one of --external-worktree-visibility, --browser-profile and --project-group.',
      'show and hide override the global non-Orca worktree visibility default for this repo; inherit clears the override.',
      'Per-worktree visibility rules still apply.',
      '--project-group takes a group id or name from `orca repo group list`; none takes the repo out of its group.',
      "--browser-profile picks the profile new browser tabs in this repo use, overriding the Browser setting's profile for new tabs; inherit clears it. Ids come from `orca tab profile list`; `default` is the Default profile."
    ],
    examples: [
      'orca repo set --repo path:/path/to/repo --external-worktree-visibility show --json',
      'orca repo set --repo name:acme-web --browser-profile <profileId> --json',
      'orca repo set --repo name:orca --project-group Work --json',
      'orca repo set --repo id:<repoId> --project-group none --json'
    ]
  },
  {
    path: ['repo', 'hide'],
    summary: "Hide a project from Orca's sidebar",
    usage: 'orca repo hide --repo <selector> [--host <host>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'host'],
    notes: [
      'Only the view changes: open terminals, agents, automations and scripts keep running, and repo list still lists the repo with hiddenAt set.',
      "Hiding applies to one host's copy; with --host, it picks which copy of a repo set up on several hosts.",
      'On a paired Orca server the flag lives on that server, so it hides the project for everyone connected to it.'
    ],
    examples: ['orca repo hide --repo name:orca --json']
  },
  {
    path: ['repo', 'unhide'],
    summary: "Show a hidden project in Orca's sidebar again",
    usage: 'orca repo unhide --repo <selector> [--host <host>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'host'],
    notes: ["Shows one host's copy again; on a paired Orca server, for everyone connected to it."]
  },
  {
    path: ['repo', 'group', 'list'],
    summary: 'List sidebar project groups',
    usage: 'orca repo group list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: ['Pass a group id or name to `--project-group` on `orca repo set` or `orca repo add`.'],
    examples: ['orca repo group list --json']
  },
  {
    path: ['repo', 'set-base-ref'],
    summary: "Set the repo's default base ref for future worktrees",
    usage: 'orca repo set-base-ref --repo <selector> --ref <ref> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'ref']
  },
  {
    path: ['repo', 'search-refs'],
    summary: 'Search branch/tag refs within a repo',
    usage: 'orca repo search-refs --repo <selector> --query <text> [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'query', 'limit']
  }
]
