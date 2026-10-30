# Plugin commands

Use these to make, check, load and manage Orca plugins (themes, terminal themes, icon themes,
syntaxes, language packs, custom editors, panels). All commands take `--json`; branch on
`error.code`, not on wording.

```text
ORCA plugin create <dir> --template <theme|terminal-theme|icon-theme|syntax|language-pack|editor|panel> --publisher <owner> [--id <id>] [--name <name>] --json
ORCA plugin validate <dir|orca-plugin.json|orca-catalog.json> --json
ORCA plugin inspect <dir> --json
ORCA plugin dev load <dir> [--approve <fingerprint>] --json
ORCA plugin dev reload [<dir>] [--approve <fingerprint>] --json
ORCA plugin dev unload <dir|plugin-key> --json
ORCA plugin list --json
ORCA plugin logs <plugin-key> --json
ORCA plugin enable <plugin-key> [--approve <fingerprint>] --json
ORCA plugin disable <plugin-key> --json
```

Exit codes: `0` ok, `1` error, `2` `plugin_invalid`, `3` `approval_required` or `approval_stale`.

## Make and load a plugin

1. `plugin create` into a new folder. Set `--publisher` to the GitHub or GitLab user or
   organization that will own the repository; `stablyai` and an `orca-` id prefix are reserved.
2. Edit the files. Field rules: `docs/reference/plugin-manifest.md`, `plugin-themes.md`,
   `plugin-theme-tokens.md`, `plugin-syntax.md` and `plugin-authoring.md` in the Orca repository.
3. `plugin validate` until it passes. It is offline and never runs plugin code.
4. `plugin dev load <dir>` adds the folder to Settings → Plugins → Development folders on the
   Orca host and loads it. Orca reloads it when its files change; run `plugin dev reload <dir>`
   if a change was missed. `plugin logs` shows what a panel or worker printed.
5. `plugin dev unload <dir>` when done.

Paths are on the machine that runs Orca. With `--environment <server>`, pass an absolute path
on that server. From an SSH or WSL shell that forwards `orca` to another machine, the authoring
and dev commands refuse; work on the Orca host instead.

`plugin_system_disabled` means plugins are off on that host. Ask the user to click "Turn on
plugins" in Settings → Plugins; there is no CLI way to turn them on.

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
- `disable` and `dev unload` never need approval.

## Publish

There is no publish command. Use Git and `gh` with the user's own credentials:

1. `plugin validate .` must pass, and the work must be committed and pushed to the GitHub
   repository whose owner matches `publisher`.
2. Set `version` in `orca-plugin.json`, commit, then tag that commit `v<version>` and push the
   tag: `git tag -a v1.2.0 -m v1.2.0 && git push origin v1.2.0`.
3. Add the `orca-plugin` topic to the repository: `gh repo edit <owner>/<repo> --add-topic orca-plugin`.
4. Check the listing status at `https://www.onorca.dev/plugins/<owner>/<repo>`.

Publishing is public and acts under the user's GitHub identity; do it only when the user asked
to publish.
