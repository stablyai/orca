# Writing an Orca plugin

From an empty folder to a plugin anyone can install from a catalog. The field-by-field rules
live in the generated references: [manifest](plugin-manifest.md), [catalog](plugin-catalog.md),
[host API](plugin-host-api.md), [themes](plugin-themes.md) and [theme tokens](plugin-theme-tokens.md),
[syntaxes](plugin-syntax.md).

## 1. Write

A plugin is a folder (in practice its own Git repository) with `orca-plugin.json` at the root.
Start from `examples/plugins/orca-gleam-syntax`, which carries the JSON Schema for editor
completion, or from one of:

| Example                              | Execution        | Shows                                |
| ------------------------------------ | ---------------- | ------------------------------------ |
| `examples/plugins/orca-gleam-syntax` | `data`           | A syntax, no code                    |
| `examples/plugins/hello-orca`        | `trusted-worker` | A panel, a worker command and events |

Pick the lowest `execution` profile that covers what you contribute; it decides what the user is
asked to approve:

- `data`: themes, terminal themes, icon themes, syntaxes, translations. Installs in one click.
- `declarative`: commands that run Orca actions, shortcuts, VM recipes. Reviewed before they
  are enabled.
- `sandboxed-ui`: panels, in a sandboxed frame that can only call the host methods marked
  "Panels: yes".
  Orca's colors reach panel CSS as `--orca-background`, `--orca-foreground`, `--orca-primary`
  and the rest of its panel token set, so they never collide with a panel's own variables.
- `trusted-worker`: `main` runs in a separate Node process and can call every host method its
  `capabilities` allow.

Set `engines.orca` to the newest `Since` of any field you use, and `pluginApi` (currently `1`)
only when a panel or worker calls the host API.

## 2. Load it while you work

1. Settings → Plugins: turn on **Plugin system**.
2. **Development folders…** → add the plugin folder. A development folder overrides an installed
   copy with the same `<publisher>.<id>`.
3. Review and enable it. Nothing runs before that.

Orca watches development folders and reloads the plugin when its manifest or files change.
Theme, syntax and translation edits show up as you save. Panels and workers are not bound to
their files in development, so saving does not ask for approval again; adding a capability or
moving to a higher execution profile does. Shortcuts and recipes are tied to their files, so
each change to them is reviewed again. Use **Restart** on the plugin row after changing a
worker, and the plugin's logs to see what it printed.

## 3. Validate

```sh
pnpm validate:plugin path/to/plugin
```

This runs the manifest checks Orca runs, strictly: unknown keys, limits, contributions beyond the
execution profile, and an `engines.orca` too low for the fields used. On a catalog it also
checks that listed images exist and fit. Run it in CI for the plugin and catalog repositories.

## 4. Publish to a catalog

A catalog is a Git repository with `orca-catalog.json` at its root that lists plugins and pins
each release to an exact commit and file hash, so Orca refuses bytes the catalog did not vouch
for.

1. Commit the plugin and run `pnpm validate:plugin` on the root of its repository. It prints the
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

   `commit` must be a full 40-character SHA. A tag or branch name is refused by validation and
   skipped by Orca. Keep the previous release listed when you raise `engines.orca`, so older
   Orca still has something to install.

3. Run `pnpm validate:plugin path/to/catalog` and regenerate the older
   `orca-marketplace.json` as described in the [catalog reference](plugin-catalog.md#clients-before-format-2).
4. Users add the catalog under Settings → Plugins → **Add marketplace** with its Git URL and ref.

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
- `agents`: new coding-agent harnesses described as data.
- `statusBarItems`: declarative status bar widgets whose values a worker updates.
- `sidebarCards`: declarative left-sidebar cards whose values a worker updates.
- `mcpServers`: MCP server definitions offered to the agents Orca launches.
- `skills`: agent skills shipped as files.
- `settings`: typed plugin settings shown in Orca's settings UI.

See [the manifest reference](plugin-manifest.md#planned-contribution-points) for details.

## Stability

Plugins are in Alpha: the manifest v2 format and catalog format are stable contracts; items
listed as experimental may change. These parts are stable and change only additively:

- manifest format 2, capability names and execution profiles;
- host API 1 (`"pluginApi": 1`): method names, params and results;
- the panel bridge message names (`orca-panel-action`, `-result`, `-ping`, `-pong`) and error
  codes;
- theme token names, and theme ids once published (users' settings store them);
- catalog format 2 (`orca-catalog.json`).

Experimental; these may still change without a new format:

- the `agent.status.changed` payload: `state` and `outcome` are free strings and `paneKey` is
  not yet a terminal id `terminal.sendText` accepts;
- the worker process model: Node version, lifecycle and the channel to Orca. Only
  `activate(orca)` and `orca.host`, `orca.commands`, `orca.events` and `orca.log` are promised,
  and workers may be stopped at any time;
- language-pack keys, which change when Orca's source moves or its English copy changes; packs
  get best-effort coverage per release;
- `pnpm validate:plugin` output; only its exit codes (`0` valid, `1` invalid, `2` usage) are
  stable;
- `settings:own`, which stores untyped values until plugins can declare settings;
- manifest format 1, which is deprecated. Catalogs need format 2.

Data folders, `orca-plugin-image://` URLs, tab keys and the `pluginRoot` a worker receives are
internal.
