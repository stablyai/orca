import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const SKILL_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['skills', 'installed'],
    summary: 'List installed skill selectors',
    usage: 'mcode skills installed [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Lists discovery IDs and names without reading skill contents into the CLI.',
      'Package metadata is validated when the selected skills are shared.',
      'Use an exact ID or an unambiguous name with `mcode skills share --skill <selector>`.'
    ]
  },
  {
    path: ['skills', 'share'],
    summary: 'Publish explicitly selected installed skills behind one unlisted link',
    usage:
      'mcode skills share --skill <selector> [--skill <selector> ...] --bundle-name <name> ' +
      '[--release-notes <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'skill', 'bundle-name', 'release-notes'],
    notes: [
      'Requires the default-off permission in Settings → Share Skills.',
      'The bundle name may be human-readable; MCode converts it to a portable lowercase package name.',
      'Selectors are exact discovery IDs or unambiguous names from `mcode skills installed`.',
      'Only discovered skill directories can be selected; arbitrary paths and --all are not supported.',
      'The resulting link is unlisted. Anyone with it can inspect and install the bundle.'
    ],
    examples: [
      'mcode skills share --skill frontend --bundle-name "Frontend Skills"',
      'mcode skills share --skill frontend --skill testing --bundle-name "Team Toolkit" --json'
    ]
  },
  {
    path: ['skills', 'list'],
    summary: 'List version-matched skill guides bundled with this MCode CLI',
    usage: 'mcode skills list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Reads bundled guide metadata locally without contacting the MCode runtime.',
      'With --json, prints a topics array of canonical names and one-line descriptions.',
      'Use `mcode skills get <name>` for the full guide, or `mcode skills install` to install skills.'
    ]
  },
  {
    path: ['skills', 'get'],
    aliases: [['skills', 'show']],
    summary: 'Print a version-matched skill guide as Markdown',
    usage: 'mcode skills get <topic> [--full] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'topic', 'full'],
    positionalArgs: ['topic'],
    notes: [
      'Reads bundled guide content locally without contacting the MCode runtime.',
      'Use --full to include bundled reference documents when the guide provides them.',
      'Use --json for a deterministic object containing canonical topic metadata and content.'
    ],
    examples: ['mcode skills get mcode-cli', 'mcode skills get orchestration --full']
  },
  {
    path: ['skills', 'install'],
    summary: 'Install bundled MCode skills via the community skills CLI',
    usage:
      'mcode skills install [--skill <name>]... [--all] [--agent <name>[,<name>]] ' +
      '[--local] [--dry-run] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'skill', 'all', 'agent', 'local', 'dry-run'],
    notes: [
      'Reads the bundled skill registry locally without contacting the MCode runtime.',
      'Resolves to the same `npx skills add <repo> --skill <name> ...` command used by ' +
        'MCode Settings, plus the non-interactive flags an unattended host needs ' +
        '(`npx --yes` and `-y`), then runs it and forwards its output and exit code.',
      'Installs globally (all projects, adds --global) by default. Use --local to install ' +
        'into the current project instead.',
      'Targets the coding agents MCode detects on this host, plus the shared ' +
        '.agents/skills directory. Without an explicit target the skills CLI installs ' +
        'into every agent it knows about, which litters a host with config ' +
        'directories for agents it does not have.',
      'Use --agent <name>[,<name>...] to choose targets yourself, or --agent universal ' +
        'for the shared directory alone. Required when MCode detects no agent.',
      'Use --dry-run to print the resolved command without running it.',
      'With --json, the skill listing and --dry-run emit JSON; a real install streams ' +
        "npx's own non-JSON output live and rejects --json.",
      'Omit --skill and --all to list installable skill names.',
      'Intended for headless hosts (SSH, containers, CI) with no desktop Settings UI to copy the install command from.'
    ],
    examples: [
      'mcode skills install',
      'mcode skills install --skill mcode-cli --skill orchestration',
      'mcode skills install --skill mcode-cli --local',
      'mcode skills install --skill mcode-cli --agent claude-code,codex',
      'mcode skills install --all --dry-run'
    ]
  },
  {
    path: ['skills', 'update'],
    summary: 'Update already-installed MCode skills via the community skills CLI',
    usage: 'mcode skills update [--skill <name>]... [--all] [--local] [--dry-run] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'skill', 'all', 'local', 'dry-run'],
    notes: [
      'Reads the bundled skill registry locally without contacting the MCode runtime.',
      'Resolves to the same `npx skills update <names...>` command used by MCode Settings, ' +
        'plus the non-interactive flags an unattended host needs (`npx --yes` and `-y`), ' +
        'then runs it and forwards its output and exit code.',
      'Updates the global install (all projects, adds --global) by default. Use --local to ' +
        'update the current project instead.',
      'Only refreshes skills that are already installed; use `mcode skills install` first.',
      'Use --dry-run to print the resolved command without running it.',
      'With --json, the skill listing and --dry-run emit JSON; a real update streams ' +
        "npx's own non-JSON output live and rejects --json.",
      'Omit --skill and --all to list updatable skill names.',
      'Intended for headless hosts (SSH, containers, CI) with no desktop Settings UI to copy the update command from.'
    ],
    examples: [
      'mcode skills update',
      'mcode skills update --skill mcode-cli --skill orchestration',
      'mcode skills update --skill mcode-cli --local',
      'mcode skills update --all --dry-run'
    ]
  }
]
