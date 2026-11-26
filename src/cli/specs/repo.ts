import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'
import { REPO_LUCIDE_ICON_NAMES } from '../../shared/repository/appearance/repo-lucide-icon-names'

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
    usage: 'orca repo add --path <path> [--kind git|folder] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'path', 'kind'],
    notes: [
      'Defaults to git. Use --kind folder for an ordinary directory, including a parent of separate Git repositories; worktrees attached to a folder workspace appear in its Source Control panel, one section each.',
      'With --environment, --path must be an absolute path on that Orca server.'
    ],
    examples: ['orca repo add --path /abs/path/to/folder --kind folder --json']
  },
  {
    path: ['repo', 'show'],
    summary: 'Show one registered repo',
    usage: 'orca repo show --repo <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo']
  },
  {
    path: ['repo', 'set'],
    summary:
      "Set a repo's sidebar group, name, color, icon, worktree visibility or browser profile",
    usage:
      'orca repo set --repo <selector> [--group <group>|none] [--group-order <n>] [--display-name <name>] [--badge-color <hex>] [--icon <lucide-name>|none] [--external-worktree-visibility show|hide|inherit] [--browser-profile <id>|inherit] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'repo',
      'group',
      'group-order',
      'display-name',
      'badge-color',
      'icon',
      'external-worktree-visibility',
      'browser-profile'
    ],
    notes: [
      '--group moves the repo into a project group from `orca group list` (id:<id>, name:<name>, or a bare id or name); none moves it out of every group. It goes last in the group unless --group-order is passed.',
      '--group-order is the sort position among the projects of the same group, lowest first; without --group it repositions the repo where it already is.',
      `--icon takes one of ${REPO_LUCIDE_ICON_NAMES.join(', ')} in any case or in kebab-case; none restores the default mark. --badge-color takes a hex color such as #22c55e.`,
      'show and hide override the global non-Orca worktree visibility default for this repo; inherit clears the override.',
      'Per-worktree visibility rules still apply.',
      "--browser-profile picks the profile new browser tabs in this repo use, overriding the Browser setting's profile for new tabs; inherit clears it. Ids come from `orca tab profile list`; `default` is the Default profile."
    ],
    examples: [
      'orca repo set --repo name:acme-web --group name:Clients --json',
      'orca repo set --repo name:acme-web --display-name "Acme Web" --badge-color "#22c55e" --icon rocket --json',
      'orca repo set --repo path:/path/to/repo --external-worktree-visibility show --json',
      'orca repo set --repo name:acme-web --browser-profile <profileId> --json'
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
