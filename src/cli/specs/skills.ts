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
      'Copies the skills this Orca build ships into the shared .agents/skills directory and ' +
        "links them into each target agent's skills directory. Needs no network, Node.js, or Git.",
      'Installs globally (all projects) by default. Use --local to install into the current ' +
        'project instead.',
      'Targets the coding agents Orca detects on this host. Use --agent <name>[,<name>...] ' +
        'to target agents detection missed, or --agent universal for the shared directory ' +
        'alone. Agents Orca already installed a skill for stay targeted, so --agent only adds.',
      'Replaces an earlier Orca version of a skill. A copy with changes Orca did not make is ' +
        'reported and left alone; use --force to replace it.',
      'Never edits the skills CLI lock file (~/.agents/.skill-lock.json); it only reads it to ' +
        'recognise copies that CLI installed from stablyai/orca.',
      'Use --dry-run to print what would change without writing anything.',
      'Omit --skill and --all to list installable skill names.',
      'Intended for headless hosts (SSH, containers, CI) with no desktop Settings UI.'
    ],
    examples: [
      'orca skills install',
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
      'Runs the same install as `orca skills install`, which replaces each selected skill ' +
        'with the copy this Orca build ships. Only skills already installed here are ' +
        'updated; use `orca skills install` to add one.',
      'Updates the global install (all projects) by default. Use --local to update the current ' +
        'project instead.',
      'A copy with changes Orca did not make is reported and left alone; use --force to ' +
        'replace it.',
      'Use --dry-run to print what would change without writing anything.',
      'Omit --skill and --all to list updatable skill names.'
    ],
    examples: [
      'orca skills update',
      'orca skills update --skill orca-cli --skill orchestration',
      'orca skills update --skill orca-cli --local',
      'orca skills update --all --dry-run'
    ]
  }
]
