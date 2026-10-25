import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const SKILL_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['skills', 'installed'],
    summary: 'List installed skill selectors',
    usage: 'orca skills installed [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Lists discovery IDs and names without reading skill contents into the CLI.',
      'Package metadata is validated when the selected skills are shared.',
      'Use an exact ID or an unambiguous name with `orca skills share --skill <selector>`.'
    ]
  },
  {
    path: ['skills', 'share'],
    summary: 'Publish explicitly selected installed skills behind one unlisted link',
    usage:
      'orca skills share --skill <selector> [--skill <selector> ...] --bundle-name <name> ' +
      '[--release-notes <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'skill', 'bundle-name', 'release-notes'],
    notes: [
      'Requires the default-off permission in Settings → Share Skills.',
      'The bundle name may be human-readable; Orca converts it to a portable lowercase package name.',
      'Selectors are exact discovery IDs or unambiguous names from `orca skills installed`.',
      'Only discovered skill directories can be selected; arbitrary paths and --all are not supported.',
      'The resulting link is unlisted. Anyone with it can inspect and install the bundle.'
    ],
    examples: [
      'orca skills share --skill frontend --bundle-name "Frontend Skills"',
      'orca skills share --skill frontend --skill testing --bundle-name "Team Toolkit" --json'
    ]
  },
  {
    path: ['skills', 'list'],
    summary: 'List version-matched skill guides bundled with this Orca CLI',
    usage: 'orca skills list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Reads bundled guide metadata locally without contacting the Orca runtime.',
      'With --json, prints a topics array of canonical names and one-line descriptions.',
      'Use `orca skills get <name>` for the compact guide, `--full` for its full reference package, or `orca skills install` to install skills.'
    ]
  },
  {
    path: ['skills', 'get'],
    aliases: [['skills', 'show']],
    summary: 'Print a version-matched skill guide as Markdown',
    usage: 'orca skills get <topic> [--full | --reference <name>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'topic', 'full', 'reference', 'references'],
    positionalArgs: ['topic'],
    notes: [
      'Reads bundled guide content locally without contacting the Orca runtime.',
      'Prints the compact guide by default. Use --full to print the full guide with bundled references when provided.',
      'Use --reference <name> to print one bundled reference alone, which is what an action gate in the compact guide needs; --references lists the available names.',
      'A reference name may be given bare (recovery-and-cleanup) or as the guide spells it (references/recovery-and-cleanup.md).',
      'Use --json for a deterministic object containing canonical topic metadata and content.'
    ],
    examples: [
      'orca skills get orca-cli',
      'orca skills get orchestration --full',
      'orca skills get orchestration --references',
      'orca skills get orchestration --reference recovery-and-cleanup'
    ]
  },
  {
    path: ['skills', 'install'],
    summary: 'Install bundled Orca skills on this machine',
    usage:
      'orca skills install [--skill <name>]... [--all] [--agent <name>[,<name>]] ' +
      '[--local] [--force] [--dry-run] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'skill', 'all', 'agent', 'local', 'force', 'dry-run'],
    notes: [
      'Reads the bundled skill registry locally without contacting the Orca runtime, ' +
        'and needs no network, Node, Git or npx.',
      'Writes the copy this Orca build ships into the shared .agents/skills folder and ' +
        'links it into each detected agent\u2019s skills folder, the same way the app\u2019s ' +
        'Update skills does.',
      'Only copies Orca wrote and nobody changed are updated. A copy you changed, or a ' +
        'different skill with the same name, is skipped and is reported; --force replaces ' +
        'it after moving it to a backup under ~/.agents/.orca-skill-backups.',
      'Installs globally (all projects) by default. Use --local to install into the ' +
        'current project; it links only into agent folders the project already has.',
      'Targets the coding agents Orca detects on this host. Use --agent <name>[,<name>...] ' +
        'to choose them yourself, or --agent universal for the shared folder alone.',
      'Use --dry-run to print what would change and the plan digest without writing; a ' +
        'real run plans again and writes only if the plan still matches.',
      'Exits 1 when a location failed or changed while it ran; skipped folders are warnings.',
      'Omit --skill and --all to list installable skill names.'
    ],
    examples: [
      'orca skills install --skill orca-cli --skill orchestration',
      'orca skills install --skill orca-cli --local',
      'orca skills install --skill orca-cli --agent claude,codex',
      'orca skills install --all --dry-run'
    ]
  },
  {
    path: ['skills', 'update'],
    summary: 'Update Orca skills to the version this Orca build ships',
    usage:
      'orca skills update [--skill <name>]... [--all] [--agent <name>[,<name>]] ' +
      '[--local] [--force] [--dry-run] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'skill', 'all', 'agent', 'local', 'force', 'dry-run'],
    notes: [
      'Runs the same planner as `orca skills install`, but only at locations that already ' +
        'hold the skill; it never adds a skill, or an existing skill for another agent.',
      'Updates each untouched copy where it is; other copies are skipped unless you ' +
        'pass --force. Use `orca skills install` to add a skill for a newly detected agent.',
      'Updates the global install by default. Use --local to update the current project.',
      'Use --dry-run to print what would change and the plan digest without writing.',
      'With --json, both dry runs and real runs print the plan, and real runs the result.',
      'Omit --skill and --all to list updatable skill names.'
    ],
    examples: [
      'orca skills update --all',
      'orca skills update --skill orca-cli --dry-run',
      'orca skills update --all --force'
    ]
  }
]
