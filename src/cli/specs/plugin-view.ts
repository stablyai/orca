import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli-argument-boundary'

/** Showing and capturing a plugin's UI in the Orca desktop app, so an agent can see what it built. */
export const PLUGIN_VIEW_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['plugin', 'open'],
    summary: "Show a plugin's panel in Orca's right sidebar, or open a file in its editor",
    usage: 'orca plugin open <plugin-key> [--panel <id> | --editor <file>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'plugin', 'panel', 'editor'],
    positionalArgs: ['plugin'],
    notes: [
      "Without --panel it shows the plugin's first panel, opening the right sidebar if it is closed. --editor opens the file in the plugin's first custom editor that takes it, in the workspace that holds the file (its real path counts, so /tmp and /private/tmp match); when none does, Orca opens the file's folder as a folder workspace and opens it there.",
      'Changes only what Orca shows: it never brings the window forward or takes focus. It leaves Settings for the workspace behind it; for a panel, other full-page views and a window with no workspace fail with no_workspace.',
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
      "orca plugin shot <plugin-key|dir> [--panel <id> | --editor <file> | --status-bar | --window] [--theme <light|dark>] [--width <px>] [--height <px>] [--act '<json>' [--in-place] | --scenario <name>] [--out <file.png>] [--allow-unreleased] [--json]",
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'plugin',
      'panel',
      'editor',
      'theme',
      'width',
      'height',
      'act',
      'in-place',
      'out',
      'scenario',
      'allow-unreleased',
      'status-bar',
      'window'
    ],
    positionalArgs: ['plugin'],
    notes: [
      'Shows the panel like `orca plugin open`, waits until it has drawn (a components panel: its first tree from the current code, then until no host call such as plugin.request is in flight and its answer has drawn, at most 3s more; an html panel: its page loaded), then captures exactly the panel, with the window hidden or behind others. It never shows, raises or focuses the window, and it does not leave Settings or another full-page view.',
      'Writes .orca/shots/<plugin-key>-<panel>.png unless --out names a file: in the plugin folder when run inside one (the nearest orca-plugin.json up to the repository root, as `dev watch --shot` does), else in <cwd>. The image is in CSS pixels. Read the image file to see the panel.',
      '--width sets the panel width for this capture only. --theme paints Orca light or dark for this capture only, and only while its window is hidden or minimized, then puts your theme back; the setting never changes. With the window on screen it captures in the current theme rather than repaint the app in front of you. The result says which theme it shows, whether --theme took effect (themeApplied) and why not (themeReason).',
      '--act runs input on a components panel before the capture, in the test kit\'s words: a JSON list (at most 20) of {"press":Q}, {"type":Q,"text":"…","replace"?:true,"submit"?:true}, {"select":Q,"value":"…"}, {"toggle":Q}, {"slide":Q,"value":n}, and for a Table {"sort":Q,"column":"…"}, {"selectRows":Q,"keys":[…]}, {"activateRow":Q,"key":"…"}, {"loadMore":Q}, for a Tree {"expand"|"collapse"|"selectItem"|"activateItem":Q,"key":"…"}, where Q matches like the kit\'s queries ({"text"|"label"|"testId"|"type"|"role":"…"}). Each act goes through Orca\'s own control and waits for the panel to redraw and its host calls to answer. After the capture Orca puts the panel\'s atoms back (persisted ones included, so neither later shots nor the user keep the acted state); what handlers did elsewhere stays, such as a plugin.request that changed the worker\'s storage. It acts only on this panel and only while Orca\'s window is hidden or minimized; html panels refuse it. Acts are not a person\'s input: a Link\'s href stays unopened and gesture-only calls (shell.openExternal, files.saveAs) are refused. The first failed act stops the rest; the PNG shows the panel at that point and the command exits 1.',
      '--json prints { path, width, height, theme, themeApplied, themeReason?, settled, errors, pendingRequests?, actions?, restored? }; pendingRequests counts host calls still unanswered at the capture (components panels), actions has one { ok, error? } per act, and restored is false when the panel reloaded during --act so its acted state stayed. errors lists the error banner the panel shows and the errors it logged (`orca plugin logs`) during the capture; settled is false when it had not finished drawing after 15s.',
      "--scenario <name> shoots the panel in one scenario of its `<entry>.check.ts` instead of the live panel. Not sandboxed: like `orca plugin check` it runs the plugin's code (panel and worker) on this machine with your user's full access, against a stand-in host, so the scenario's data never reaches the plugin's real panel, storage, settings or worker; then the Orca on this machine draws what it rendered apart from the plugin (the right sidebar is not opened or switched) and captures it. It takes a plugin folder, or the key of a development plugin when run inside its folder; installed plugins are refused. A replay is a still frame: host-owned control values start from the tree's props, images show their placeholder, it has no --act, and it is local only (no --environment). It needs Orca's window hidden or minimized, since the preview is drawn inside it; --theme then always applies. Writes .orca/shots/<plugin-key>-<panel>.<scenario>.png in the plugin folder unless --out names a file; --json adds replay: true, scenario and notes, and errors lists what the render reported. An unknown name fails and lists the scenarios.",
      '--allow-unreleased permits source-only fields when reading a local plugin folder for --scenario or --editor and rendering its scenario against this SDK. Released engine floors still apply; this does not establish compatibility with a published Orca release.',
      'With --editor <file> it shoots the plugin\'s custom editor instead: it opens the file like `orca plugin open --editor` (a folder or a key works as the first argument), waits for the editor to get its document and ask for it (`orca.document.get` or `onDidChange`) and paint, then captures exactly the editor, hidden window included. --width/--height size the editor for this capture only; --theme works as for panels and is put back after. --act there is real input to the editor in its own CSS pixels from its top-left: a JSON list (at most 20) of {"click":[x,y]}, {"drag":[[x1,y1],[x2,y2]]} and {"key":"r","modifiers"?:["shift"|"control"|"alt"|"meta"]}, each painted before the next; it needs the window hidden or minimized. A shot never changes your file: with --act it shoots a copy in a temporary folder workspace that it removes afterwards, unless --in-place acts on the file itself (edits then reach its buffer like typing, and its tab stays open with them; end --act with {"key":"s","modifiers":["meta"]}, "control" off macOS, to save them to disk). Without --act it opens the file itself, leaves its buffer alone and closes the tab if the shot opened it. Writes .orca/shots/<plugin-key>-<editor-id>.png unless --out names a file. The PNG is written either way, but the command exits 1 and prints the errors when the editor threw, was blocked by its content policy (both from `orca plugin logs`), or never asked for its document within 5s. Orca\'s previous workspace is shown again afterwards.',
      "--status-bar captures Orca's status bar, where a plugin's status bar items draw, and --window the whole window; both from the hidden window like a panel shot, never showing or focusing it. They take --theme (put back after) and --out, and write .orca/shots/<plugin-key>-status-bar.png or -window.png. The plugin must be running; errors lists what it logged during the capture. On Linux an html panel's guest may show blank in a --window shot; use a panel shot for it.",
      'Desktop app only: a server with no window (`orca serve`) refuses it. With --environment the PNG (at most 5 MiB; it shows only the plugin panel) comes back to this machine and is written here.'
    ],
    examples: [
      'orca plugin shot acme.todos',
      'orca plugin shot acme.todos --theme light --width 360 --out ./todos-light.png',
      'orca plugin shot acme.todos --panel stats --json',
      'orca plugin shot . --scenario counted --theme dark',
      'orca plugin shot . --editor ./sample.sketch --theme light --width 800 --height 600',
      'orca plugin shot acme.todos --status-bar --theme dark',
      'orca plugin shot acme.sketch --editor ./sample.sketch --act \'[{"click":[200,150]},{"drag":[[200,150],[400,300]]},{"key":"r"}]\'',
      'orca plugin shot acme.todos --act \'[{"type":{"label":"New task"},"text":"Ship","submit":true},{"toggle":{"label":"Hide done"}}]\''
    ]
  }
]
