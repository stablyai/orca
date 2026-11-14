import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli-argument-boundary'
import { LOCAL_COMMAND_FLAGS } from '../arguments/args'

const RESULT_NOTE =
  'Every change returns the draft revision, what changed, `paint`, and `report`: per mode, the `findings` of the contrast check, each with an `id`, its `effect`, the failing pair with `ratio` and `min`, and `fixes` that pass. `report` is null when the window did not paint in time.'
const MODE_NOTE =
  '--mode light|dark|both picks the variants to change; without it, the mode Orca shows now.'
const CONCURRENCY_NOTE =
  '--if-revision <n> refuses with draft_conflict when the draft moved past revision n (another agent, or the person). After the person presses Keep or Discard, or picks a theme in Settings, the next change fails once with draft_ended_by_user: ask them before starting again. Changes are limited to about 3 a second per terminal (rate_limited with retryAfterMs); batch tokens into one command. When "Let agents edit the theme" is off in Settings → Appearance, changes fail with theme_edits_disabled.'
const PAINT_NOTE =
  '`paint` says how the change reached the screen: painted, other-variant (the mode you changed is not the one shown; use `orca theme shot --mode`), no-viewer, coalesced or timeout, with `dropped` (tokens the window actually left unpainted) and `editor` (follows-app, or pinned when the user chose a fixed editor theme, so syntax colors do not show).'
const DESKTOP_NOTE =
  'Needs the Orca desktop app (local, or a desktop server with --environment); a headless `orca serve` fails with theme_needs_desktop.'

export const THEME_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['theme', 'show'],
    summary: 'Show the theme draft being previewed, or the themes in use',
    usage: 'orca theme show [--resolved] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'resolved'],
    notes: [
      'Prints whether a draft is open, its name, modes, undo/redo depth, history and current contrast report; with --json also the draft itself (`tokens`, `tokenColors`, `terminal` per mode).',
      "--resolved adds every token as Orca paints it now for each mode (hex), with `source` (theme, derived or built-in), the terminal palette and the selected theme's id; it ignores the draft, so it shows the user's own themes.",
      DESKTOP_NOTE
    ],
    examples: ['orca theme show --json', 'orca theme show --resolved --json']
  },
  {
    path: ['theme', 'tokens'],
    summary: 'List every token a theme can set, with what it paints',
    usage: 'orca theme tokens [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS],
    notes: [
      'Works without Orca running. App tokens are named `--background` or `background`; terminal colors `terminal.<key>` (background, foreground, cursor, selectionBackground, black … brightWhite).'
    ],
    examples: ['orca theme tokens --json']
  },
  {
    path: ['theme', 'edit'],
    summary: 'Start a theme draft and preview it live, from the current theme or another',
    usage:
      'orca theme edit [--from current|<theme-id>|<plugin-key>|<dir>|<file.json>] [--name <name>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'if-revision', 'from', 'name'],
    notes: [
      "A draft paints over the user's theme without changing any setting; `orca theme apply` keeps it and `orca theme discard` drops it. Starting a new draft replaces the open one.",
      '--from current (the default) starts from exactly what Orca paints now in both modes, including the terminal palette and syntax colors. An installed theme id or plugin key starts from that theme. A theme plugin folder or theme JSON file on this machine is read as data only; its code never runs.',
      'Orca shows a "Previewing" notice with Keep and Discard while a draft is open.',
      RESULT_NOTE,
      DESKTOP_NOTE
    ],
    examples: [
      'orca theme edit --name "Ember" --json',
      'orca theme edit --from ./dusk-theme --json',
      'orca theme edit --from acme.dusk-theme --json'
    ]
  },
  {
    path: ['theme', 'set'],
    summary: 'Change draft tokens, terminal colors or syntax colors; previews at once',
    usage:
      'orca theme set <token>=<color>... [--mode light|dark|both] [--unset <token>]... [--patch <json|@file> | --patch-stdin] [--if-revision <n>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'if-revision',
      'assignment',
      'mode',
      'unset',
      'patch',
      'patch-stdin'
    ],
    positionalArgs: ['assignment'],
    variadicPositional: true,
    repeatableFlags: ['assignment', 'unset'],
    notes: [
      'Write tokens without the leading dashes (`sidebar=#20160f`); the shell would read `--sidebar` as a flag. Colors are hex, rgb(), hsl() or oklch(); terminal colors are hex.',
      '--patch-stdin reads the same JSON from standard input: the quoting-safe way to send many tokens, Windows shells included.',
      '--patch takes JSON (or @file) shaped `{"dark":{"set":{"background":"#1b1410"},"unset":["chart-2"],"tokenColors":[...]},"light":{...}}`; `tokenColors` uses the plugin theme shape and replaces the list (null removes it).',
      'Opens a draft from the current theme first when none is open. An unknown token fails with the nearest names.',
      MODE_NOTE,
      RESULT_NOTE,
      PAINT_NOTE,
      CONCURRENCY_NOTE
    ],
    examples: [
      'orca theme set background=#1b1410 foreground=#f3e6d8 --mode dark --json',
      'orca theme set worktree-sidebar=#140e0a worktree-sidebar-foreground=#f6eadc --mode both --json',
      'orca theme set terminal.background=#1b1410 terminal.red=#f2766b --mode dark --json'
    ]
  },
  {
    path: ['theme', 'adjust'],
    summary: 'Shift the whole draft warmer, cooler, brighter or more saturated',
    usage:
      'orca theme adjust [--warmth <-100..100>] [--hue <deg>] [--saturation <%>] [--lightness <%>] [--contrast <%>] [--separate <ΔL> [--scope sidebar|tabs|cards|editor]] [--only <prefix,...>] [--mode light|dark|both] [--if-revision <n>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'warmth',
      'hue',
      'saturation',
      'lightness',
      'contrast',
      'only',
      'mode',
      'separate',
      'scope'
    ],
    notes: [
      'Works in OKLCH, so lightness and readability move evenly across hues. --warmth tints greys and turns hues toward amber (positive) or blue (negative); --contrast moves the lightness of each color away from (positive) or toward (negative) the background it sits on (terminal colors from the terminal background), so `--contrast 20 --only worktree-sidebar` sets the sidebar further apart and keeps its text readable. Percentages run -100 to 100.',
      'Applies to app tokens, terminal colors and syntax colors; --only limits it to keys starting with any listed prefix (`sidebar,worktree-sidebar,terminal.`). Colors it cannot read are listed under `skipped`.',
      '--separate <ΔL> steps an area\'s surfaces that much OKLCH lightness away from the canvas, keeping hue and chroma (0.03 to 0.06 reads as a clear step; negative brings them closer). --scope picks the area: sidebar (both sidebars with their hover and selected rows, the default), tabs, cards or editor. Use it for "make the sidebar more distinct".',
      'Without --mode it changes both modes. Contrast issues the change causes are fixed in the same step with the smallest lightness moves; `autoFixed` says how many.',
      RESULT_NOTE
    ],
    examples: [
      'orca theme adjust --warmth 35 --json',
      'orca theme adjust --contrast 15 --only worktree-sidebar,sidebar --json'
    ]
  },
  {
    path: ['theme', 'check'],
    summary: "Check the draft's contrast in both modes, and optionally fix it",
    usage: 'orca theme check [--fix [--finding <id>]...] [--if-revision <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'if-revision', 'fix', 'finding'],
    repeatableFlags: ['finding'],
    notes: [
      "The same check Orca runs before painting any theme: text keeps 4.5:1 on its surface (3:1 for file status colors), focus rings 2:1, borders stay visible. A token that fails shows Orca's built-in color instead, so a draft with issues looks different from what you set.",
      'Each finding has a stable `id`, the `effect` the person will see, up to two `fixes` (text-side and surface-side, each with `set`, `ratio` and `deltaE`, smallest change first, lightness only) and a ready `command`.',
      '--fix applies the smallest fix of every finding, re-checks and repeats (up to 4 rounds) as one undo step; --finding <id> fixes only those findings.',
      RESULT_NOTE
    ],
    examples: [
      'orca theme check --json',
      'orca theme check --fix --json',
      'orca theme check --fix --finding dark-text-worktree-sidebar-foreground-on-worktree-sidebar --json'
    ]
  },
  {
    path: ['theme', 'history'],
    summary: "List the draft's steps, who made each, and where undo stands",
    usage: 'orca theme history [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Each step has its label, who made it (agent and pane, or "you" for the notice\'s buttons), how many issues were fixed with it, and whether it saved the theme.'
    ],
    examples: ['orca theme history --json']
  },
  {
    path: ['theme', 'reset'],
    summary: 'Go back to where the draft started, as one undoable step',
    usage: 'orca theme reset [--if-revision <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'if-revision'],
    examples: ['orca theme reset --json']
  },
  {
    path: ['theme', 'undo'],
    summary: 'Undo the last draft change',
    usage: 'orca theme undo [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'if-revision'],
    notes: [
      'History holds the last 100 changes of the open draft. Undo right after `apply` puts back the themes the user had and reopens the draft.'
    ],
    examples: ['orca theme undo --json']
  },
  {
    path: ['theme', 'redo'],
    summary: 'Redo a draft change that was undone',
    usage: 'orca theme redo [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'if-revision'],
    examples: ['orca theme redo --json']
  },
  {
    path: ['theme', 'shot'],
    summary: 'Save a PNG of the whole Orca window with the draft painted',
    usage: 'orca theme shot [--mode light|dark] [--out <file.png>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'mode', 'out'],
    notes: [
      "Read the image to see the result. --mode paints that mode for this capture only, and only while Orca's window is hidden or minimized; with the window on screen it captures the mode shown (`themeApplied: false` and `themeReason` say so). The window is never shown or focused.",
      'Writes to --out, else to a file in the system temp folder; --json prints { path, width, height, mode, themeApplied, themeReason?, draft }.',
      DESKTOP_NOTE
    ],
    examples: ['orca theme shot --json', 'orca theme shot --mode light --out ./light.png --json']
  },
  {
    path: ['theme', 'apply'],
    summary: 'Keep the draft: save it as a theme and use it',
    usage: 'orca theme apply [--name <name>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'if-revision', 'name'],
    notes: [
      'Saves the draft as a content-only theme plugin installed from a folder (`local.<id>`, no approval needed), selects it for each mode it has, app and terminal, and closes the draft. Orca shows a notice with Switch back. Applying again under the same name replaces that theme.',
      'Saving is itself a history step: `orca theme undo` right after it restores the previous themes.',
      'Needs plugins turned on (Settings → Plugins).'
    ],
    examples: ['orca theme apply --json', 'orca theme apply --name "Ember" --json']
  },
  {
    path: ['theme', 'discard'],
    summary: 'Close the draft without keeping it',
    usage: 'orca theme discard [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'if-revision'],
    notes: ["Orca paints the user's own theme again; nothing was changed."],
    examples: ['orca theme discard --json']
  },
  {
    path: ['theme', 'export'],
    summary: 'Write the draft as a publishable theme plugin folder',
    usage: 'orca theme export <dir> [--name <name>] [--id <plugin-id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dir', 'name', 'id'],
    positionalArgs: ['dir'],
    notes: [
      'Writes orca-plugin.json, themes/<mode>.json, terminal/<mode>.json when the draft has a full palette, and a README into an empty or new folder on this machine, then runs the strict checks of `orca plugin validate`. Publish it like any plugin (`orca skills get orca-plugin-authoring`).',
      'The draft stays open.'
    ],
    examples: ['orca theme export ./ember-theme --name "Ember" --json']
  }
]
