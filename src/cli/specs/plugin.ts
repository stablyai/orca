import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS, LOCAL_COMMAND_FLAGS } from '../args'
import { PLUGIN_TEMPLATE_NAMES } from '../plugin-authoring/plugin-template-names'

const TEMPLATES = PLUGIN_TEMPLATE_NAMES.join('|')

const EXIT_CODES_NOTE =
  'Exit codes: 0 ok, 1 error, 2 the plugin is invalid (plugin_invalid), 3 approval is needed (approval_required or approval_stale).'

export const PLUGIN_AUTHORING_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['plugin', 'create'],
    summary: 'Scaffold a new Orca plugin from a template',
    usage: `orca plugin create <dir> --template <${TEMPLATES}> [--publisher <name>] [--id <id>] [--name <display name>] [--json]`,
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'dir', 'template', 'publisher', 'id', 'name'],
    positionalArgs: ['dir'],
    notes: [
      'Writes into a new or empty folder (a .git folder is allowed) and never overwrites; it runs no Git, package install or plugin code.',
      'theme, terminal-theme, icon-theme, syntax and language-pack are content only: loading them never needs approval.',
      'editor and panel run code in a sandboxed frame: loading them prints the access they ask for and needs --approve.',
      'components is a panel written in TSX with Orca components and no build step; it also writes the editor typings to .orca/types (see `orca plugin types`).',
      'The id defaults to the folder name. Leave out --publisher: Orca names the publisher after the repository owner (or `local` for a folder). Pass it only to support Orca older than 1.4.246, and then it must be that owner.',
      'Runs on the machine that runs this command; it does not reach the Orca app.',
      EXIT_CODES_NOTE
    ],
    examples: [
      'orca plugin create ./dusk-theme --template theme --publisher acme',
      'orca plugin create ./notes-editor --template editor --name "Notes" --json',
      'orca plugin create ./todo-panel --template components'
    ]
  },
  {
    path: ['plugin', 'types'],
    summary: 'Write the TypeScript typings for Orca plugins into a plugin folder',
    usage: 'orca plugin types <dir> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'dir'],
    positionalArgs: ['dir'],
    notes: [
      'Writes .orca/types/orca/index.d.ts and .orca/types/tsconfig.json; extend it from the plugin tsconfig (`"extends": "./.orca/types/tsconfig.json"`). `.orca/` ignores itself in Git, and Orca skips it when loading a development folder.',
      'The typings match the Orca this CLI belongs to. `orca plugin dev load` rewrites them for folders that use TypeScript or components panels.',
      'Runs on the machine that runs this command; it does not reach the Orca app.',
      EXIT_CODES_NOTE
    ],
    examples: ['orca plugin types .']
  },
  {
    path: ['plugin', 'validate'],
    summary: 'Check a plugin folder, manifest or catalog the way Orca will load it',
    usage: 'orca plugin validate <dir|orca-plugin.json|orca-catalog.json> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'path'],
    positionalArgs: ['path'],
    notes: [
      'Runs the strict checks of `pnpm validate:plugin`: manifest, limits, execution profile, every theme, icon, syntax and translation file, and every file the manifest names.',
      'Offline; never runs plugin code. The result says whether loading needs --approve and what it would grant.',
      EXIT_CODES_NOTE
    ],
    examples: ['orca plugin validate .', 'orca plugin validate ./dusk-theme --json']
  },
  {
    path: ['plugin', 'inspect'],
    summary: 'Show what a plugin folder contributes, the access it asks for, and its content hash',
    usage: 'orca plugin inspect <dir> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'path'],
    positionalArgs: ['path'],
    notes: [
      'Validates like `orca plugin validate`, then hashes the files the way install does.',
      'Use it to show your user exactly what a plugin would be allowed to do before loading it.',
      EXIT_CODES_NOTE
    ],
    examples: ['orca plugin inspect ./notes-editor --json']
  },
  {
    path: ['plugin', 'release-entry'],
    summary: "Print the catalog release entry for a plugin folder's committed HEAD",
    usage: 'orca plugin release-entry <dir> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'path'],
    positionalArgs: ['path'],
    notes: [
      'Validates like `orca plugin validate`, then hashes the files of HEAD (not the working tree) the way install does, and prints the `releases` entry to paste into orca-catalog.json, plus the `source.path` when the plugin is a subdirectory of its repository.',
      'Offline; runs only local read-only Git and never runs plugin code. Uncommitted changes are left out, with a note.',
      'Fails with plugin_invalid when the folder is invalid, and with invalid_argument when it is not committed in a Git repository or HEAD has no installable release.',
      EXIT_CODES_NOTE
    ],
    examples: ['orca plugin release-entry .', 'orca plugin release-entry ./gleam-syntax --json']
  }
]

const APPROVE_NOTE =
  'Content-only plugins (themes, icons, syntaxes, translations) need no approval. Anything that runs code or acts in Orca fails with approval_required, which lists exactly what it would be granted, why, and the command to re-run with --approve <fingerprint>. The fingerprint is bound to that plugin, version, files and access; anything different needs a new one.'

export const PLUGIN_RUNTIME_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['plugin', 'list'],
    summary: 'List plugins on the Orca host with their status and access level',
    usage: 'orca plugin list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Status is running, idle, pending (waiting for approval), disabled, errored or invalid; dev marks development folders.'
    ],
    examples: ['orca plugin list --json']
  },
  {
    path: ['plugin', 'logs'],
    summary: 'Print the recent log lines of a plugin',
    usage: 'orca plugin logs <plugin-key> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'plugin'],
    positionalArgs: ['plugin'],
    notes: ['Shows the last lines a plugin worker printed and its activation errors.'],
    examples: ['orca plugin logs acme.notes --json']
  },
  {
    path: ['plugin', 'enable'],
    summary: 'Enable a plugin; code and capabilities need --approve',
    usage: 'orca plugin enable <plugin-key> [--approve <fingerprint>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'plugin', 'approve'],
    positionalArgs: ['plugin'],
    notes: [
      APPROVE_NOTE,
      'Enabling a plugin that is already approved and running needs nothing; re-enabling a disabled plugin that runs code needs --approve again.',
      EXIT_CODES_NOTE
    ],
    examples: ['orca plugin enable acme.dusk', 'orca plugin enable acme.notes --approve ap1-…']
  },
  {
    path: ['plugin', 'disable'],
    summary: 'Disable a plugin',
    usage: 'orca plugin disable <plugin-key> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'plugin'],
    positionalArgs: ['plugin'],
    notes: ['Never needs approval.'],
    examples: ['orca plugin disable acme.notes']
  },
  {
    path: ['plugin', 'system', 'on'],
    summary: 'Turn plugins on for the Orca host',
    usage: 'orca plugin system on [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'The same switch as "Turn on plugins" in Settings → Plugins, for a host with no window such as `orca serve`.',
      'Approves nothing: only plugins approved earlier start; anything else still needs its own --approve.'
    ],
    examples: ['orca plugin system on', 'orca plugin system on --environment build-box --json']
  },
  {
    path: ['plugin', 'system', 'off'],
    summary: 'Turn plugins off for the Orca host',
    usage: 'orca plugin system off [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Stops every plugin and keeps installs, approvals and development folders. Never needs approval.'
    ],
    examples: ['orca plugin system off']
  },
  {
    path: ['plugin', 'restart'],
    summary: "Stop a plugin's worker so its next command or event starts it fresh",
    usage: 'orca plugin restart <plugin-key> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'plugin'],
    positionalArgs: ['plugin'],
    notes: [
      'Never needs approval and keeps the plugin enabled. Also clears a worker stopped for crashing repeatedly.',
      'Dev folders restart their worker on file changes already; use this to rerun startup code.',
      EXIT_CODES_NOTE
    ],
    examples: ['orca plugin restart acme.notes']
  },
  {
    path: ['plugin', 'dev', 'load'],
    summary: 'Load a plugin folder into Orca as a development plugin',
    usage: 'orca plugin dev load <dir> [--approve <fingerprint>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dir', 'approve'],
    positionalArgs: ['dir'],
    notes: [
      'Adds the folder to Settings → Plugins → Development folders on the Orca host; it overrides an installed plugin with the same key.',
      'Orca reloads the plugin when its files change. For an approved panel, editor or worker, later code edits run without asking again; new access does not.',
      '.ts, .tsx, .mts and .jsx files load without a build step. When the folder uses them (or components panels) and is on this machine, this also refreshes its .orca/types typings, like `orca plugin types`.',
      APPROVE_NOTE,
      'Without approval the folder stays loaded but nothing in it runs.',
      'With --environment the folder is a path on that Orca server; pass it absolute.',
      EXIT_CODES_NOTE
    ],
    examples: ['orca plugin dev load ./dusk-theme', 'orca plugin dev load ./notes-editor --json']
  },
  {
    path: ['plugin', 'dev', 'reload'],
    summary: 'Reload development plugins now, or one folder and re-check its approval',
    usage: 'orca plugin dev reload [<dir>] [--approve <fingerprint>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dir', 'approve'],
    positionalArgs: ['dir'],
    notes: [
      'Orca already reloads on file changes; use this when a change was missed (network or WSL folders) or after changing commands or shortcuts, which need a new approval.',
      EXIT_CODES_NOTE
    ],
    examples: ['orca plugin dev reload', 'orca plugin dev reload ./notes-editor --json']
  },
  {
    path: ['plugin', 'dev', 'inspect'],
    summary: "Open DevTools for a plugin's open panels and editors",
    usage: 'orca plugin dev inspect <plugin-key> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'plugin'],
    positionalArgs: ['plugin'],
    notes: [
      'Desktop app only: opens one detached DevTools window per open frame. Console errors and uncaught exceptions also reach `orca plugin logs` without it.',
      EXIT_CODES_NOTE
    ],
    examples: ['orca plugin dev inspect acme.notes']
  },
  {
    path: ['plugin', 'dev', 'unload'],
    summary: 'Remove a development folder from Orca',
    usage: 'orca plugin dev unload <dir|plugin-key> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'target'],
    positionalArgs: ['target'],
    notes: [
      'Never needs approval. An installed plugin with the same key comes back, needing its own approval if access differs.'
    ],
    examples: ['orca plugin dev unload ./notes-editor', 'orca plugin dev unload acme.notes']
  }
]
