# Plugin commands

Use these to make, check, load and manage Orca plugins (themes, terminal themes, icon themes,
syntaxes, language packs, custom editors, panels, TSX component panels). All commands take `--json`; branch on
`error.code`, not on wording.

```text
ORCA plugin create <dir> --template <theme|terminal-theme|icon-theme|syntax|language-pack|editor|panel|components|worker-panel> [--id <id>] [--name <name>] --json
ORCA plugin types <dir> --json
ORCA plugin validate <dir|orca-plugin.json|orca-catalog.json> --json
ORCA plugin inspect <dir> --json
ORCA plugin release-entry <dir> --json
ORCA plugin test [dir] --json
ORCA plugin check [dir] --json
ORCA plugin dev watch <dir> [--check] [--shot <out-dir> [--shot-panel <id>]] [--approve <fingerprint>] --json
ORCA plugin dev load <dir> [--approve <fingerprint>] --json
ORCA plugin dev reload [<dir>] [--approve <fingerprint>] --json
ORCA plugin dev emit <dir|plugin-key> <event> [--data <json>] --json
ORCA plugin dev request <dir|plugin-key> <name> [--data <json>] [--panel <id>] [--timeout-ms <ms>] --json
ORCA plugin dev unload <dir|plugin-key> --json
ORCA plugin list --json
ORCA plugin logs <plugin-key> --json
ORCA plugin enable <plugin-key> [--approve <fingerprint>] --json
ORCA plugin disable <plugin-key> --json
ORCA plugin system on|off --json
ORCA plugin restart <plugin-key> --json
ORCA plugin open <plugin-key> [--panel <id> | --editor <file>] --json
ORCA plugin shot <plugin-key> [--panel <id>] [--theme light|dark] [--width <px>] [--act '<json>'] [--out <file.png>] --json
ORCA plugin shot <dir> --scenario <name> [--panel <id>] [--theme light|dark] [--width <px>] [--out <file.png>] --json
```

Exit codes: `0` ok, `1` error, `2` `plugin_invalid`, `3` `approval_required` or `approval_stale`.

## Make and load a plugin

1. `plugin create` into a new folder. Leave out `--publisher`: Orca names the publisher after the
   repository owner (`local` for a folder); an `orca-` id prefix is reserved. `components` is a TSX
   panel with no build step; `.ts`/`.tsx` files load as written, importing only `orca` and
   relative files. `plugin types <dir>` (also run by `plugin dev load`) writes the typings to
   `.orca/types/`, which the plugin's `tsconfig.json` extends.
2. Edit the files. Field rules: `docs/reference/plugin-manifest.md`, `plugin-themes.md`,
   `plugin-theme-tokens.md`, `plugin-syntax.md` and `plugin-authoring.md` in the Orca repository.
3. `plugin validate` until it passes. It is offline and never runs plugin code. For components
   panels, `plugin check` also renders each panel once in Node and reports runtime errors with
   file:line, and `plugin test` runs the plugin's `*.test.ts(x)` files with `orca/testing`
   (see `docs/reference/plugin-declarative-ui.md`, "Testing"). Both run the plugin's code
   unsandboxed on this machine: use them only on code you trust.
4. `plugin dev load <dir>` adds the folder to Settings → Plugins → Development folders on the
   Orca host and loads it. Orca reloads it, and restarts its worker, when its files change; run
   `plugin dev reload <dir>` if a change was missed. `plugin restart <plugin-key>` stops a
   worker so its next command or event reruns its startup code. `plugin logs` shows what a worker printed and a panel's or editor's
   console errors, warnings and uncaught exceptions as `[frame] <file>:<line> <message>`.
   `plugin dev inspect <plugin-key>` opens DevTools windows for its open frames; run it only
   when the user asks. `plugin dev watch <dir> --json` does the load, then stays running and
   prints one JSON object per line (`type`: `loaded`, `log`, `reloaded`, `status`, `approval`,
   `check`, `shot`, `shot_skipped`, `warning`, `disconnected`, `unloaded`) as logs arrive and saves reload it;
   run it in a background terminal and read its output. Ctrl-C unloads the folder it loaded.
   `plugin dev emit <dir|plugin-key> <event> --data '<json>'` fires a test event at a
   development plugin's worker (if it lists the event in `contributes.events`) and its open
   panels that subscribed with `orca.on`; the payload is checked against the event's schema.
   Handler errors show in `plugin logs` and the watch.
   `plugin dev request <dir|plugin-key> <name> --data '<json>'` calls the worker's
   `orca.panels.handle(name)` handler as a panel's `plugin.request` would and prints
   `{ pluginKey, name, result }`; a handler failure is `plugin_request_failed` with the worker's
   code in `error.data.requestCode`.
5. See what you built: `plugin shot <plugin-key> --json` writes a PNG of a panel exactly as Orca
   draws it (default `.orca/shots/<plugin-key>-<panel>.png`, in the plugin folder when run inside
   one; `--width` applies to that capture only, and `--theme` too but only while Orca's window is
   hidden or minimized, else `themeApplied: false` with a `themeReason`) and lists the errors the
   panel showed or logged; read the image file. A components panel's shot also waits for its
   host calls (`plugin.request`) to answer, at most 3s; `pendingRequests` counts any still out.
   `--act '[{"type":{"label":"New task"},"text":"Ship"},{"press":{"text":"Add"}}]'`
   first drives a components panel with the test kit's verbs (`press`, `type`, `select`,
   `toggle`, `slide`, Table `sort`/`selectRows`/`activateRow`/`loadMore`, Tree
   `expand`/`collapse`/`selectItem`/`activateItem`; at most 20) and reports
   `actions: [{ ok, error? }]`; it needs Orca's window hidden or minimized and never counts as a
   user gesture. Afterwards the panel's atoms are put back (`restored`); worker-side effects stay.
   `plugin shot <dir> --scenario <name>` shoots one `<entry>.check.ts` scenario instead: it renders
   it here like `plugin check` (unsandboxed, the worker on a stand-in host), and Orca draws that
   tree apart from the plugin, so the live panel, storage and worker are never touched. It returns
   `replay: true` and `scenario`; a still frame (images placeholder, no `--act`), local only,
   window hidden or minimized; an unknown name lists the scenarios. `plugin dev watch <dir> --shot <out-dir>` opens one panel once (the
   first, or `--shot-panel <id>`) and captures it after every reload while it stays on screen;
   when the user shows something else it skips (`shot_skipped`) and never switches back. `plugin open
   <plugin-key>` shows a panel to the user (`--editor <file>` opens a file in its custom editor).
   Both need the desktop app with a workspace showing and never raise the window.
6. `plugin dev unload <dir>` when done.

Paths are on the machine that runs Orca. With `--environment <server>`, pass an absolute path
on that server. From an SSH or WSL shell that forwards `orca` to another machine, the authoring
and dev commands refuse; work on the Orca host instead.

`plugin_system_disabled` means plugins are off on that host. Ask the user to click "Turn on
plugins" in Settings → Plugins, or on a host with no window (`orca serve`) to run
`plugin system on` with the same `--environment`. It approves nothing; only plugins approved
earlier start.

## Approval

- Content-only plugins (themes, terminal themes, icon themes, syntaxes, language packs) load
  and enable without approval.
- Anything that runs code or acts in Orca (panels, editors, commands, shortcuts, workers,
  capabilities) fails with `approval_required` (exit 3). `error.message` and `error.data`
  say exactly what it would be granted, why approval is needed, and `error.data.command`, the
  same command with `--approve <fingerprint>`.
- The fingerprint is bound to that plugin, version, files and access. A different plugin,
  version, set of files, or more access gets `approval_stale` with the new grants and a new
  fingerprint.
- Approving grants real access on the user's machine or server. Ask your user before re-running
  with `--approve` unless they already asked for exactly this plugin and this access. Never pass a
  fingerprint you did not get from Orca for this exact command. Each approval is written to the
  plugin audit log as approved via CLI.
- Without approval a development folder stays loaded but nothing in it runs.
- For an approved development folder, later code edits run without asking again; new
  capabilities, a higher execution level, or changed commands and shortcuts need a new approval.
- `disable`, `restart` and `dev unload` never need approval.

## Publish

There is no publish command. Use Git and `gh` with the user's own credentials:

1. `plugin validate .` must pass, and the work must be committed and pushed to the GitHub
   repository that will own it (its owner becomes the publisher).
2. Set `version` in `orca-plugin.json`, commit, then tag that commit `v<version>` and push the
   tag: `git tag -a v1.2.0 -m v1.2.0 && git push origin v1.2.0`.
3. Add the `orca-plugin` topic to the repository: `gh repo edit <owner>/<repo> --add-topic orca-plugin`.
4. Check the listing status at `https://www.onorca.dev/plugins/<owner>/<repo>`.

For a catalog (`orca-catalog.json`), commit the plugin and run `plugin release-entry <dir>`: it
prints the `releases` entry for `HEAD` (and the `source.path` for a plugin in a subdirectory) to
paste into the catalog, newest first.

Publishing is public and acts under the user's GitHub identity; do it only when the user asked
to publish.
