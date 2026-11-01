---
name: orca-plugin-authoring
description: >-
  Build, debug, test, and publish Orca plugins end to end: app, terminal, and icon themes,
  syntaxes, language packs, custom editors, HTML or TSX components sidebar panels, palette
  commands and shortcuts, and Node worker commands that react to workspace and agent events.
  Use when the user asks to make, change, fix, or ship an Orca plugin, to add a panel,
  command, theme, editor, or language to Orca, or works in a folder with an orca-plugin.json.
  Use `orca-cli` only to list, enable, or disable plugins that are already installed.
---

# Orca Plugin Authoring

`ORCA` is a placeholder for the executable you resolved in the stub; substitute it before running.
Pass `--json` to every `ORCA plugin` command and branch on `error.code`, not on wording.

## Where things live

- **Your files:** a new folder, ideally its own Git repository, with `orca-plugin.json` at its
  root. Create it with `ORCA plugin create`, which never overwrites. Paths are on the machine that
  runs Orca; with `--environment` pass an absolute path on that server.
- **Types:** `ORCA plugin types <dir>` (also run by `dev load` and `dev watch`) writes
  `.orca/types/`: `orca` (components panels), `orca-frame` (the global `orca` in HTML panels and
  editors), `orca-worker` (`import type { OrcaWorkerApi } from 'orca/worker'`) and `orca-host`
  (host methods and event payloads). The plugin's `tsconfig.json` extends
  `./.orca/types/tsconfig.json`. Never edit `.orca/`; it ignores itself in Git.
- **Ground truth:** the generated references below describe the Orca this CLI belongs to. Read
  them instead of guessing props, methods or fields.

## Pick the shape

Use the lowest `execution` profile that covers the request; it decides what the user must approve.

| The user asks for                                         | Build (manifest)                                                    | Start from                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------ |
| An app color theme                                        | `data`; `contributes.themes`                                        | `--template theme`                               |
| A terminal color palette                                  | `data`; `contributes.terminalThemes`                                | `--template terminal-theme`                      |
| File icons                                                | `data`; `contributes.iconThemes`                                    | `--template icon-theme`                          |
| Highlighting for a language                               | `data`; `contributes.syntaxes` (TextMate grammar)                   | `--template syntax`; example `orca-gleam-syntax` |
| Orca's UI in another language                             | `data`; `contributes.languagePacks`                                 | `--template language-pack`                       |
| A custom view or editor for a file type                   | `sandboxed-ui`; `contributes.customEditors`, optionally `newFiles`  | `--template editor`                              |
| A sidebar panel of lists, forms, buttons, status          | `sandboxed-ui`; `panels` entry `.tsx` with `"ui": "components"`     | `--template components`; example `hello-tsx`     |
| A sidebar panel needing its own HTML, canvas or libraries | `sandboxed-ui`; `panels` entry `.html` (or `.ts`/`.tsx`)            | `--template panel`                               |
| A palette command or shortcut for a built-in Orca action  | `declarative`; `commands[].action`, `keybindings`                   | hand-written; fields in `references/manifest.md` |
| A command that runs code, storage, secrets, terminal text | `trusted-worker`; `main`, `commands` (no `action`), `capabilities`  | example `hello-orca`                             |
| Reacting to workspace or agent status changes             | `trusted-worker`; `main`, `contributes.events`, `*:read` capability | example `hello-orca`                             |
| A virtual machine environment recipe                      | `declarative`; `contributes.vmRecipes`                              | hand-written; fields in `references/manifest.md` |

Examples are in `examples/plugins/` of github.com/stablyai/orca. Status bar items, sidebar cards,
task sources, connections, MCP servers, skills, hooks and plugin settings UI are reserved and not
buildable yet: say so instead of faking them. A panel cannot type into a terminal; only a worker
with `terminal:send` can.

## No build step

- `.ts`, `.tsx`, `.mts` and `.jsx` load as written; transpiling strips types and never
  type-checks, so run `npx tsc -p .`. `const enum` across files and `export =` are unsupported.
- Components panels and frame scripts import only `orca`, `orca/*` and relative files
  (`./todos` finds `todos.tsx`, `todos.ts`, then `todos/index.*`). A bare package such as `react`
  fails: copy its ESM files into the plugin and import them relatively, or bundle with
  `--external:orca --external:'orca/*'` (example `hello-components`).
- Only components panels get JSX for `orca`. An HTML frame using JSX must ship its own runtime.
- A worker `main` is `.js`, `.mjs`, `.ts` or `.mts` (no `.tsx`). `node:` builtins and other bare
  imports resolve as Node resolves them, but `node_modules/` must not be committed, so bundle npm
  dependencies. `orca/worker` is types only: `import type`.

## The loop

1. `ORCA plugin create ./my-plugin --template components --json`. Leave out `--publisher`.
2. Start `ORCA plugin dev watch ./my-plugin --check --json` in a background terminal and keep
   reading it. It loads the folder, refreshes `.orca/types`, then prints one JSON object per
   line: `loaded`, `log`, `reloaded`, `status` (with `errored` or `invalid` and the error),
   `approval`, `check` (with `--check`), `warning`, `disconnected`, `unloaded`. A first load that needs consent exits `3`; see
   [Approval](#approval).
3. Edit and save. Each save prints `reloaded`, then a `check` with what each panel drew or threw.
   Console errors and uncaught exceptions arrive as `log` lines `[frame] <file>:<line> <message>`
   at your source line. Fix every one, and run `ORCA plugin test <dir> --json` after changes.
4. Off the watch, `ORCA plugin logs <plugin-key> --json` shows the same lines,
   `ORCA plugin restart <plugin-key>` reruns a worker's startup code, and
   `ORCA plugin dev reload <dir>` catches a missed save or re-checks changed commands and shortcuts.
5. Stop the watch with Ctrl-C (it unloads the folder it loaded) or run `ORCA plugin dev unload <dir>`.

You cannot see the panel. Ask the user to open it, or use the check step below.

## Test and check

Both run the plugin's code on this machine, outside Orca's sandbox: only on code you trust.

- `ORCA plugin test [dir] --json` runs every `*.test.ts(x)` (also `.mts`, `.js(x)`, `.mjs`)
  under the folder, skipping `node_modules`, `.orca`, `dist` and dot-folders, with `node:test`,
  or the plugin's own vitest when it has one. `orca` and `orca/testing` resolve to what this Orca
  ships. Stdout is one `{ ok, result: { runner, code, node: 'system' | 'orca', files } }`; the
  exit code is the runner's (`plugin_tests_failed` on failure).
- `ORCA plugin check [dir] --json` validates, then renders each components panel once against a
  stand-in host with the manifest's capabilities: what it threw (with `file:line:col`), layouts
  Orca would refuse, props it would drop. Exit `0` ok, `1` `plugin_check_failed`, `2` invalid.
- `ORCA plugin dev watch <dir> --check` runs the check after the load and each reload and
  prints it inline (a `check` event with `--json`).

Put tests next to the panel (`src/panel.test.tsx`; the components template writes one):

```tsx
import { afterEach, assert, mount, test, type TestPanel } from 'orca/testing'
import * as panelModule from './panel'

let panel: TestPanel | undefined
afterEach(() => panel?.unmount())

test('adds a task', async () => {
  panel = await mount(panelModule, { persisted: { plugin: { todos: [] } } })
  await panel.type({ label: 'New task' }, 'Ship it', { submit: true })
  assert.ok(panel.find({ role: 'button', text: /Ship it/ }))
  assert.equal(panel.valueOf({ label: 'New task' }), '')
  assert.deepEqual(panel.errors, [])
})
```

- `mount(module, { host, theme, locale, visible, panelId, persisted })` runs `setup`, renders
  and resolves once drawn; every mount resets every atom; one panel at a time. `stored(value,
  version)` seeds what an older version wrote, to test `migrate`.
- `find` (innermost match or `null`) and `findAll` take `type`, `role`, `text`, `label` or
  `testId` (the element's `key`). `text` and `label` match exactly: use a RegExp for part.
- `press`, `type(el, text, { replace?, submit? })`, `submit`, `toggle`, `select(el, value)` take
  an element or a query and resolve once renders, host calls and persisted writes settle: `await`
  them and never add sleeps. `valueOf`, `tree()`, `errors`, `warnings`, `persisted` inspect.
- `mockHost({ capabilities, results })` (pass as `host`) refuses what Orca refuses: undeclared
  capabilities, bad params, and `shell.openExternal`/`files.saveAs` without a `press` first.
  `results` values or functions may throw `hostError(code)`; `callsOf(method)` records calls.
- Mount the module, never call its default export: without `mount` there is no runtime. A
  control with `value` but no `onChange` is read-only, so `type`/`toggle` throw on it.

## Ship

1. `ORCA plugin validate <dir> --json` until it exits `0`. It is offline and runs no plugin code.
2. Show the user `ORCA plugin inspect <dir> --json`: what it contributes and the access it asks for.
3. Publish only when the user asks; it is public and uses their GitHub identity. Commit and push
   to the repository that will own it (its owner becomes the publisher), set `version`, tag
   `v<version>` and push the tag, add the `orca-plugin` topic, and for a catalog paste the entry
   `ORCA plugin release-entry <dir> --json` prints for committed `HEAD`. The exact Git and `gh`
   steps are in the `orca-cli` plugins reference:
   `ORCA skills get orca-cli --reference references/plugins.md`.

## Approval

Content-only plugins (themes, icons, syntaxes, language packs) load without approval. Anything
that runs code or acts in Orca (panels, editors, commands, shortcuts, workers, capabilities) fails
with `approval_required` (exit `3`) whose `error.data` lists what it would be granted and the same
command with `--approve <fingerprint>`. Approving grants real access on the user's machine: show
them that list and re-run with `--approve` only when they asked for exactly this plugin and this
access. Never approve on their behalf otherwise, and never pass a fingerprint Orca did not give you
for that command. After one approval, code edits reload without asking; new capabilities, a higher
profile, or changed commands and shortcuts print a new approval (`approval_stale`).
`plugin_system_disabled` means plugins are off: ask the user to click "Turn on plugins" in
Settings → Plugins (on a windowless `orca serve` host, `ORCA plugin system on`).

## Gotchas

- Set `engines.orca` to the newest `Since` of any field you use (`references/manifest.md`).
  Components panels, `ui` and build-less entries need `>=1.4.246`, as does leaving out
  `publisher`. Ids starting `orca-` are reserved. Set `"pluginApi": 1` only when code calls the host.
- `update(atom, fn)` takes an updater function only; `set(atom, value)` stores a value.
- Keyed atoms (`atom('draft', '')`) survive a hot reload; unkeyed `atom(0)`, module variables and
  `setup` start over. `persist: 'plugin'` or `'workspace'` survive restarts and must be plain
  JSON; bump `version` (with `migrate`) when the stored shape changes.
- Components panels have no hooks and no DOM: state lives in atoms, and `read()` while rendering
  subscribes. `set` and `update` throw while rendering. Give reordering list items a `key`.
- A save that fails to load keeps the last good render with an inline `file:line:column` error.
  The panel is not fixed until a later save prints `reloaded` without an error.
- Frames and components panels have no network: requests outside the plugin's files fail
  whatever your CSP says. Ship assets in the folder and load them by relative URL.
- `shell.openExternal` and `files.saveAs` need a user gesture (a press on a settled `Button`,
  `IconButton`, `ListItem` or `Link`) and the desktop app; never call them on load.
- Components panels and build-less frame scripts need isolated plugin frames (on by default in
  the desktop app; browser clients of `orca serve` show the panel as unavailable).
- Host params are strict: check `host.has(method)` before using a method newer than your floor.
- Dev loads skip the top-level `.orca/` and `node_modules/`; do not commit them. A plugin holds at
  most 2,000 files and 50 MiB, a panel or editor entry 10 MiB, and each transpiled file 1 MiB.

## Conditional references

Run `ORCA skills get orca-plugin-authoring --reference references/<file>.md` and read only the
document you need; `--references` lists them. If `--reference` is rejected, run
`ORCA skills get orca-plugin-authoring --full` once and read the named section. All are generated
from this Orca's source, so they match the CLI you are running.

| Action gate                                                      | Reference                  |
| ---------------------------------------------------------------- | -------------------------- |
| Writing a components panel: components, props, atoms, `host`     | `references/components.md` |
| Calling the host from a worker, frame or panel; capabilities     | `references/host-api.md`   |
| Subscribing to worker, frame or panel events and their payloads  | `references/events.md`     |
| Writing or fixing `orca-plugin.json`, choosing `engines.orca`    | `references/manifest.md`   |
| Running any `ORCA plugin` command you have not used in this task | `references/cli.md`        |
