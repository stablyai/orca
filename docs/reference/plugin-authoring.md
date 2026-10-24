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
- `instructional`: commands that run Orca actions, shortcuts, VM recipes. Reviewed before they
  are enabled.
- `sandboxed-ui`: panels, in a sandboxed frame that can only call the host methods marked
  "Panels: yes".
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
   Orca, contribution types and summary, capabilities and file types. Every field must match
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

An update that asks for a new capability or changes the execution profile is never applied
silently. Orca asks the user to approve it again.
