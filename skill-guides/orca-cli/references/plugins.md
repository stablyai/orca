# Plugin commands

Use these to make, check, load, install and manage Orca plugins (themes, terminal themes, icon
themes, syntaxes, language packs, custom editors, panels). All commands take `--json`; branch on
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
ORCA plugin install <publisher.id|owner/repo[@ref]|git-url|page-url|dir> [--ref <ref>] [--catalog <name>] [--approve <fingerprint>] --json
ORCA plugin update <plugin-key|--all> [--approve <fingerprint>] --json
ORCA plugin uninstall <plugin-key> --json
ORCA plugin catalog list --json
ORCA plugin catalog add <owner/repo|git-url> [--ref <branch>] [--approve <fingerprint>] --json
ORCA plugin catalog rm <id|name|url> --json   # alias: catalog remove
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

## Install, update and remove

`plugin install` accepts:

- a catalog id such as `acme.dusk` (from Orca's official, the community or an added catalog;
  `--catalog` picks one when several list it),
- `owner/repo` or `owner/repo@v1.2.0` on GitHub,
- any `https://` or `ssh://` Git URL or `git@host:owner/repo.git`, with `#ref` for a version,
- a GitHub or GitLab release, tag or tree page URL (`.../releases/tag/v1.2.0`, `.../-/tree/main`),
- a plugin folder (a path on the Orca host).

With no version, Orca installs the newest version tag (`vX.Y.Z`), else the default branch, and
always pins the exact commit. The result names the version, commit, publisher and repository.

```text
ORCA plugin install acme/dusk-theme --json                     # content only: installs and enables
ORCA plugin install acme/notes-panel@v1.4.0 --json             # code: exits 3 with approval_required
ORCA plugin install acme/notes-panel@v1.4.0 --approve ap1-… --json
ORCA plugin update --all --json
ORCA plugin uninstall acme.notes-panel --json
```

`plugin update` moves catalog installs to the release their catalog offers now, Git installs from
a version tag to the newest version tag and from a branch to its newest commit; a commit pin stays.
An update from the same repository that asks for no new access keeps its approval. One that adds
capabilities, a higher execution level, commands, shortcuts or panels, or that comes from another
repository, fails with `approval_required` listing exactly what grows; the running version keeps
working until it is approved. `--all` updates everything it can and exits 3 with one
`--approve` command per plugin still waiting.

`plugin uninstall` and `plugin catalog rm` never need approval. `plugin catalog add` always
does: a catalog decides which repositories Orca installs and auto-updates from, so the first run
returns `approval_required` with a `cat1-…` fingerprint for that exact URL and branch.

## Private repositories

Git runs on the Orca host (the `--environment` server when given) with that machine's own Git
credentials and never prompts. Nothing to pass to `orca`; set up Git there once:

- HTTPS on GitHub: `gh auth login` then `gh auth setup-git`. GitLab: `glab auth login`. Elsewhere:
  any credential helper (Git Credential Manager, osxkeychain, libsecret).
- SSH: a key in `ssh-agent` that the server accepts, with its host key in `known_hosts`, then
  install with `git@github.com:owner/repo.git`.

```text
ORCA plugin install git@github.com:acme/private-panel.git --json
ORCA plugin install https://github.com/acme/private-panel --json
```

If that host's Git cannot read the repository, the command fails with `git_auth_failed`.
`error.data` has `executionHost`, `transport` (`https` or `ssh`), `gitHost` and `nextSteps` for
that host. Never put a token or password in the URL; Orca refuses it.

## Approval

- Content-only plugins (themes, terminal themes, icon themes, syntaxes, language packs) load,
  install and enable without approval.
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
- `install` and `update` decide approval before writing anything: without it nothing is
  installed and the running version is untouched. For anything not from Orca's official catalog
  the message also names the publisher (the repository owner) and the source repository; show
  that to your user, since Orca has not checked that code.
- Without approval a development folder stays loaded but nothing in it runs.
- For an approved development folder, later code edits run without asking again; new
  capabilities, a higher execution level, or changed commands and shortcuts need a new approval.
- `disable`, `uninstall`, `dev unload` and `catalog rm` never need approval.

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
