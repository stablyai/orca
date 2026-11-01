import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

/** Showing and capturing a plugin's UI in the Orca desktop app, so an agent can see what it built. */
export const PLUGIN_VIEW_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['plugin', 'open'],
    summary: "Show a plugin's panel in Orca's right sidebar, or open a file in its editor",
    usage: 'orca plugin open <plugin-key> [--panel <id> | --editor <file>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'plugin', 'panel', 'editor'],
    positionalArgs: ['plugin'],
    notes: [
      "Without --panel it shows the plugin's first panel, opening the right sidebar if it is closed. --editor opens the file in the plugin's first custom editor that takes it.",
      'Changes only what Orca shows: it never brings the window forward or takes focus. It leaves Settings for the workspace behind it; other full-page views and a window with no workspace fail with no_workspace.',
      'The plugin must be running or idle (approved and enabled); a pending plugin fails and says how to approve it.',
      'Desktop app only: a server with no window (`orca serve`) refuses it. With --environment, --editor takes an absolute path on that host.',
      'Use it to show your user the panel you just built; `orca plugin shot` captures it for you.'
    ],
    examples: [
      'orca plugin open acme.todos',
      'orca plugin open acme.todos --panel stats',
      'orca plugin open acme.notes --editor ./docs/plan.notes'
    ]
  },
  {
    path: ['plugin', 'shot'],
    summary: 'Save a PNG of a plugin panel exactly as Orca draws it, to look at what you built',
    usage:
      'orca plugin shot <plugin-key> [--panel <id>] [--theme <light|dark>] [--width <px>] [--out <file.png>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'plugin', 'panel', 'theme', 'width', 'out'],
    positionalArgs: ['plugin'],
    notes: [
      'Shows the panel like `orca plugin open`, waits until it has drawn (a components panel: its first tree from the current code; an html panel: its page loaded), then captures exactly the panel, with the window hidden or behind others. It never shows, raises or focuses the window, and it does not leave Settings or another full-page view.',
      'Writes <cwd>/.orca/shots/<plugin-key>-<panel>.png unless --out names a file; the image is in CSS pixels. Read the image file to see the panel.',
      '--width sets the panel width for this capture only. --theme paints Orca light or dark for this capture only (a visible window shows it for about a second) and puts your theme back; the setting never changes. The result says which theme it shows and whether --theme took effect (themeApplied).',
      '--json prints { path, width, height, theme, themeApplied, settled, errors }. errors lists the error banner the panel shows and the errors it logged (`orca plugin logs`) during the capture; settled is false when it had not finished drawing after 15s.',
      'Desktop app only: a server with no window (`orca serve`) refuses it. With --environment the PNG (at most 5 MiB; it shows only the plugin panel) comes back to this machine and is written here.'
    ],
    examples: [
      'orca plugin shot acme.todos',
      'orca plugin shot acme.todos --theme light --width 360 --out ./todos-light.png',
      'orca plugin shot acme.todos --panel stats --json'
    ]
  }
]
