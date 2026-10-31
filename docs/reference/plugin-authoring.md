# Writing an Orca plugin

From an empty folder to a plugin anyone can install from a catalog. The field-by-field rules
live in the generated references: [manifest](plugin-manifest.md), [catalog](plugin-catalog.md),
[host API](plugin-host-api.md), [themes](plugin-themes.md) and [theme tokens](plugin-theme-tokens.md),
[syntaxes](plugin-syntax.md). Listed plugins must follow the
[plugin listing policy](plugin-listing-policy.md).

## 1. Write

A plugin is a folder (in practice its own Git repository) with `orca-plugin.json` at the root.
Start from `examples/plugins/orca-gleam-syntax`, which carries the JSON Schema for editor
completion, or from one of:

| Example                              | Execution        | Shows                                |
| ------------------------------------ | ---------------- | ------------------------------------ |
| `examples/plugins/orca-gleam-syntax` | `data`           | A syntax, no code                    |
| `examples/plugins/hello-orca`        | `trusted-worker` | A panel, a worker command and events |

Leave `publisher` out. Orca names the publisher after where the plugin comes from, the way a
[Go module path](https://go.dev/ref/mod#module-path) is its repository path: the owner of the
repository, lowercased (`acme` for `github.com/Acme/gleam-syntax`), so the plugin installs as
`acme.gleam-syntax`. Nobody can choose a publisher name that is not theirs.

| Installed from                    | Publisher                                                    |
| --------------------------------- | ------------------------------------------------------------ |
| The official or community catalog | the repository owner, set by the catalog in the entry's `id` |
| Another catalog                   | whatever that catalog's entry `id` says                      |
| A Git URL                         | the URL's owner (`.` and `_` become `-`)                     |
| A local or development folder     | `local`                                                      |

`publisher` is deprecated: Orca ignores it for catalog and Git installs. Leaving it out needs
`engines.orca` of at least `>=1.4.246`, because older Orca requires the field and refuses a
value that differs from the catalog's. To keep supporting older Orca, keep `publisher` and set it
to the repository owner; `validate:plugin` warns about it either way. An install made before
1.4.246 keeps its key, approvals and data. A local or development folder that still declares
`publisher` keeps using it until you remove it.

When copying the Gleam example, also drop its `stablyai` publisher and `orca-` id prefix: both are
reserved for Orca's own plugins, as are owners named `official`, `anthropic`, `openai`, `github`
or starting with `orca`.

Pick the lowest `execution` profile that covers what you contribute; it decides what the user is
asked to approve:

- `data`: themes, terminal themes, icon themes, syntaxes, translations. Installs in one click.
- `declarative`: commands that run Orca actions, shortcuts, VM recipes. Reviewed before they
  are enabled.
- `sandboxed-ui`: panels and custom editors, in a sandboxed frame that talks to Orca only
  through `window.orca` (see [Frames](#frames-windoworca)) and can call only the host methods
  whose surfaces list `panel` or `editor`.
  Orca's colors reach frame CSS as `--orca-background`, `--orca-foreground`, `--orca-primary`
  and the rest of its panel token set, so they never collide with a frame's own variables.
- `trusted-worker`: `main` runs in a separate Node process and can call every host method its
  `capabilities` allow. There is no global switch for these full-access plugins: each one runs
  only after the user approves it on install. An enterprise policy to block full-access plugins
  may come later.

Set `engines.orca` to the newest `Since` of any field you use, and `pluginApi` (currently `1`)
only when a panel or worker calls the host API.

### Frames: `window.orca`

Before any plugin code runs, the frame shell defines a frozen `window.orca`. It is the only
supported way to talk to Orca; the messages underneath are internal and change without notice.

```js
orca.api // { major: 1, minor: 0 }: the host API this Orca implements
if (orca.host.has('workspace.readContext')) {
  // Synchronous: is the method offered to this surface by this Orca?
  const controller = new AbortController()
  try {
    const context = await orca.host.call('workspace.readContext', {}, { signal: controller.signal })
  } catch (error) {
    // error.code, error.message, error.retryable, error.retryAfterMs (rate_limited only)
  }
}
const subscription = orca.on('theme', ({ colorScheme }) => {})
subscription.dispose()
```

Methods, their surfaces and their errors are in the [host API reference](plugin-host-api.md).
Aborting the `signal` rejects the call with `cancelled`. Treat an error `code` you do not know as
`action_failed`. Params are strict: a field the running Orca does not know is refused with
`invalid_params`, so check `orca.host.has` or `orca.api.minor` before using a newer one.

Workers get the same calls on the `orca` object passed to `activate(orca)`:
`orca.api`, `orca.host.call(method, params, { signal })`, `orca.host.has(method)`, plus
`orca.commands.register(id, (args, { signal }) => …)` and `orca.events.on(event, handler)`, which
both return `{ dispose() }`. A command's `signal` aborts when Orca stops waiting for it. In
`agent.status.changed`, `state` and `mainAgent.state` are one of `working`, `blocked`, `waiting`
and `done`.

### Custom editors

A custom editor opens files that end in one of its `extensions` (with the dot, such as
`.excalidraw`) or carry one of its exact `filenames` in the editor tab, beside Source. Syntaxes
match files the same way. It runs in the same sandboxed frame as a panel (no Node, no file system), and Orca keeps
the buffer, dirty state, saving, the external-change banner, read-only tabs and remote (SSH or
paired host) files; the frame only gets the document, never a path. Editor and panel plugins are
trusted code, and an editor can read every file it opens, so install ones you trust.

An editor's `window.orca` adds `document`:

```js
const doc = await orca.document.get() // { version, readOnly, content, fileType? }
// The current document right away, then each one Orca sends when the file changes outside the editor.
orca.document.onDidChange((doc) => render(doc))
await orca.document.applyEdit({ baseVersion: doc.version, content: { kind: 'text', text } })
orca.on('editor.flush', () => sendPendingEdit()) // before a save; Orca waits for the promise
```

`content` is `{ kind: 'text', text }` for a text editor (the default `contentKind`). An edit is
the full new content, made against document `baseVersion`; send one only when the user changes
the document, never on load. `applyEdit` rejects with `conflict` when the file changed outside
the editor since that version (edit the newer document instead), `too_large` past the size cap,
and `not_permitted` when `readOnly` is true (an agent transcript, say). `version` rises with each
document Orca sends, not with your own edits.

Set `"contentKind": "bytes"` for a binary format such as a spreadsheet. Orca reads the file
itself (locally, over SSH or from a paired host) and the document's `content` is
`{ kind: 'bytes', bytes }`, where `bytes` is an `ArrayBuffer`, plus the matched suffix as
`fileType`. An edit is the whole new file the same way: `content: { kind: 'bytes', bytes }`.
Orca marks the tab dirty and saves the bytes with the tab's normal save, replacing the file
atomically; a save is refused if the file changed on disk since the document's version, and the
banner offers Reload or Overwrite. Saving to a remote host needs an Orca server new enough to
replace binary files. Source shows the binary placeholder, unsaved bytes are not kept across
restarts, and bytes tabs don't autosave.

Documents and edits are capped at 64 MiB, text or bytes, on every route (local, SSH and paired
hosts): a larger file shows "too large to open", and a larger edit is rejected with `too_large`.
Past 16 MiB the tab notes that the file may take a moment. Orca saves on its own save shortcut pressed
inside the frame, never on a call alone.

Theme changes do not reload the frame: the shell updates the `--orca-*` variables and the
`light`/`dark` class on `<html>` in place and emits `theme`. Restyle from the variables, or
listen with `orca.on('theme', …)`, to follow it.

## 2. Load it while you work

1. Settings → Plugins: click **Turn on plugins**.
2. **Development folders…** → add the plugin folder. It loads as `local.<id>` (or under its
   deprecated `publisher` while it still declares one), and overrides an installed copy with
   the same key.
3. Review and enable it. Nothing runs before that.

From a terminal (or a coding agent), `orca plugin dev load <dir>` does the same. A content-only
plugin loads at once; anything that runs code fails with `approval_required`, which lists what it
would be granted and the command to re-run with `--approve <fingerprint>`. `orca plugin logs
<publisher.id>` prints its logs and `orca plugin dev unload <dir>` removes it.

Orca watches development folders and reloads the plugin when its manifest or files change.
Theme, syntax and translation edits show up as you save. Panels and workers are not bound to
their files in development, so saving does not ask for approval again; adding a capability or
moving to a higher execution profile does. Shortcuts and recipes are tied to their files, so
each change to them is reviewed again. Use **Restart** on the plugin row after changing a
worker, and the plugin's logs to see what it printed.

## 3. Validate

```sh
pnpm validate:plugin path/to/plugin
# or, without an Orca checkout:
orca plugin validate path/to/plugin
```

`orca plugin create <dir> --template <theme|terminal-theme|icon-theme|syntax|language-pack|editor|panel>`
scaffolds a plugin that passes these checks, and `orca plugin inspect <dir>` shows what it would be
allowed to do and its content hash.

This runs the manifest checks Orca runs, strictly: unknown keys, limits, contributions beyond the
execution profile, and an `engines.orca` too low for the fields used. On a catalog it also
checks that listed images exist and fit. It warns when the manifest still declares the deprecated
`publisher`, and, in a Git repository, when that value is not the owner of the `origin` remote.
Warnings do not fail the check. Run it in CI for the plugin and catalog repositories.

## 4. List it in the Orca plugin directory

1. `orca plugin validate .` passes, and the plugin is committed and pushed to the GitHub
   repository whose owner matches `publisher`.
2. Commit the new `version` in `orca-plugin.json`, then tag that commit and push the tag:
   `git tag -a v1.2.0 -m v1.2.0 && git push origin v1.2.0`.
3. Add the `orca-plugin` topic to the repository: `gh repo edit <owner>/<repo> --add-topic orca-plugin`.
4. Check its listing at `https://www.onorca.dev/plugins/<owner>/<repo>`.

## 5. Publish to a catalog

A catalog is a Git repository with `orca-catalog.json` at its root that lists plugins and pins
each release to an exact commit and file hash, so Orca refuses bytes the catalog did not vouch
for. Plugins in Orca's official and community catalogs must follow the
[plugin listing policy](plugin-listing-policy.md), starting with being free to install and use.

1. Commit the plugin and run `pnpm validate:plugin` on its directory. It prints the
   release entry for `HEAD`: version, full commit SHA, `contentHash`, execution profile, minimum
   Orca, contribution summary, capabilities and file types. Every field must match
   what Orca finds at install, so paste it rather than writing it by hand.
2. Add or update the plugin's entry in the catalog's `orca-catalog.json`, newest release first:

   ```json
   {
     "id": "acme.gleam-syntax",
     "source": {
       "kind": "git",
       "url": "https://github.com/acme/orca-gleam-syntax.git",
       "ref": "main"
     },
     "categories": ["languages"],
     "releases": [{ "...": "the printed entry" }]
   }
   ```

   The `id` is `<publisher>.<manifest id>`. In your own catalog you choose the publisher; use the
   repository owner, as the official and community catalogs do.

   `commit` must be a full 40-character SHA. A tag or branch name is refused by validation and
   skipped by Orca. Keep the previous release listed when you raise `engines.orca`, so older
   Orca still has something to install.

   **One repository can hold many plugins.** Put each in its own directory, such as
   `plugins/gleam-syntax/orca-plugin.json`, and add `"path": "plugins/gleam-syntax"` to its
   `source`; validating that directory prints the `path` to use. Orca installs only that
   directory, and its `contentHash` covers only its files, so commits to sibling plugins never
   change it. Moving a plugin to another directory counts as a different repository.

3. Run `pnpm validate:plugin path/to/catalog` and regenerate the older
   `orca-marketplace.json` as described in the [catalog reference](plugin-catalog.md#clients-before-format-2).
4. Users add the catalog under Settings → Plugins → ⋯ → **Catalog sources…** with its Git URL and ref.

Users approve a plugin once per level of access. An update from the same repository that asks
for nothing new, code changes included, installs without asking again and stays enabled. Orca
asks again, listing what is new, when an update adds a capability, raises the execution profile,
adds a command, shortcut, panel or event subscription, ships virtual machine recipes, or comes from
a different repository.

With **Update plugins automatically** on (the default), Orca installs such updates for enabled
catalog plugins by itself, checking at startup and every 6 hours. A release installs only once it
has been listed for 12 hours, or at once from the official catalog, so a takedown has time to land.
Only pinned catalog releases (a `releases` entry with its commit and content hash) install by
themselves; a listing without one updates only when the user clicks Update. This includes
full-access plugins: an update that asks for nothing new runs its new code with the access the user
already granted, the same way an editor's extensions update. Turn the setting off to review every
update. An update that needs approval is not installed: the current version keeps running and the
plugin shows **Update needs review**.

## Planned contribution points

These `contributes` keys are reserved: a manifest may list them only as empty arrays until
their format ships. Each is planned as declared data that Orca renders and enforces, not
arbitrary plugin UI:

- `taskSources`: issue and task providers such as Asana, Linear or Jira, filled by a worker.
- `connections`: account providers with a host-run sign-in.
- `agentHarnesses`: new coding-agent harnesses described as data.
- `statusBarItems`: declarative status bar widgets whose values a worker updates.
- `sidebarCards`: declarative left-sidebar cards whose values a worker updates.
- `mcpServers`: MCP server definitions offered to the agents Orca launches.
- `skills`: agent skills shipped as files.
- `hooks`: agent lifecycle hooks for the agents Orca launches.
- `settings`: typed plugin settings shown in Orca's settings UI.

`skills`, `mcpServers` and `hooks` will mean what they mean in agent-plugin formats such as
Claude Code's. Orca does not reserve `agents`, because those formats use it for subagent files.

See [the manifest reference](plugin-manifest.md#planned-contribution-points) for details.

## Stability

Plugins are in Alpha: the manifest v2 format and catalog format are stable contracts; items
listed as experimental may change. These parts are stable and change only additively:

- manifest format 2, capability names and execution profiles;
- host API 1 (`"pluginApi": 1`): method names, params, results, surfaces and error codes;
- the frame API `window.orca` (`api`, `host.call`, `host.has`, `on`, and `document` in custom
  editors) and the document `version`/`content` shape;
- theme token names, and theme ids once published (users' settings store them);
- catalog format 2 (`orca-catalog.json`).

Experimental; these may still change without a new format:

- the `agent.status.changed` payload: `paneKey` is not yet a terminal id `terminal.sendText`
  accepts;
- the worker process model: Node version, lifecycle and the channel to Orca. Only
  `activate(orca)` and `orca.api`, `orca.host`, `orca.commands`, `orca.events` and `orca.log` are
  promised,
  and workers may be stopped at any time;
- language-pack keys, which change when Orca's source moves or its English copy changes; packs
  get best-effort coverage per release;
- `pnpm validate:plugin` output; only its exit codes (`0` valid, `1` invalid, `2` usage) are
  stable;
- `settings:own`, which stores untyped values until plugins can declare settings;
- manifest format 1, which is deprecated. Catalogs need format 2.

Data folders, `orca-plugin-image://` URLs, tab keys and the `pluginRoot` a worker receives are
internal.
