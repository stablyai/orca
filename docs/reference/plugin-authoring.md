# Writing an Orca plugin

From an empty folder to a plugin anyone can install from a catalog. The field-by-field rules
live in the generated references: [manifest](plugin-manifest.md), [catalog](plugin-catalog.md),
[host API](plugin-host-api.md), [themes](plugin-themes.md) and [theme tokens](plugin-theme-tokens.md),
[syntaxes](plugin-syntax.md). Listed plugins must follow the
[plugin listing policy](plugin-listing-policy.md).

## 1. Write

A plugin is a folder (in practice its own Git repository) with `orca-plugin.json` at the root.
Start from one of these, or scaffold one with `orca plugin create` (see [Validate](#3-validate)).
Add the `$schema` line from `orca-gleam-syntax` to your manifest for editor completion.

| Example                               | Execution        | Shows                                                                                                                     |
| ------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `examples/plugins/orca-gleam-syntax`  | `data`           | A syntax, no code                                                                                                         |
| `examples/plugins/hello-tsx`          | `sandboxed-ui`   | A [components](plugin-declarative-ui.md) TSX panel with no build step                                                     |
| `examples/plugins/hello-worker-panel` | `trusted-worker` | A TSX panel with its own worker, storage atom, settings and events ([Panels, workers and data](#panels-workers-and-data)) |
| `examples/plugins/hello-components`   | `sandboxed-ui`   | The same kind of [components](plugin-declarative-ui.md) panel, bundled first                                              |
| `examples/plugins/hello-orca`         | `trusted-worker` | A panel, a worker command and events                                                                                      |

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
  and the rest of its [frame variables](plugin-theme-tokens.md#frame-css-variables), so they never
  collide with a frame's own variables.
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
orca.api // { major: 1, minor: 2 }: the host API this Orca implements
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

Two calls need a click or key press in the frame (they reject with `not_permitted` otherwise)
and work only in the desktop app (in browser clients `orca.shell` and `orca.files` are undefined and
`orca.host.has` answers false):

```js
button.onclick = () => orca.shell.openExternal('https://example.com/docs') // http:, https:, mailto:
// Orca asks the person before a web host this plugin was not allowed; { opened: false } if they cancel.
const { status } = await orca.files.saveAs({
  suggestedName: 'chart.png',
  mimeType: 'image/png',
  data: arrayBuffer
})
// status is 'saved' or 'cancelled' (the person closed the dialog). The plugin never learns the
// path, and the file is marked as downloaded so the OS warns before opening it. Any mimeType is
// accepted; the dialog filters by the suggested name's extension. Executable, script, installer,
// shortcut and disk-image types (.exe, .js, .sh, .app, .lnk, .iso…) are refused.
```

`orca.locale` is Orca's UI language as a BCP-47 tag (`navigator.language` follows the
operating system, not Orca). `<input type="file">` opens the system file picker.

Methods, their surfaces and their errors are in the [host API reference](plugin-host-api.md).
Aborting the `signal` rejects the call with `cancelled`. Treat an error `code` you do not know as
`action_failed`. Params are strict: a field the running Orca does not know is refused with
`invalid_params`, so check `orca.host.has` or `orca.api.minor` before using a newer one.

#### Files and assets

In the desktop app each plugin's frames run in their own isolated process, storage and origin,
`orca-plugin-frame://<key>/`, served from your plugin folder. Load scripts, styles, images, fonts,
WASM and workers by relative URL (`<script src="lib/app.js">`, `new Worker('worker.js')`,
`WebAssembly.instantiateStreaming(fetch('lib/mod.wasm'))`), and `localStorage` and IndexedDB
persist per plugin. The network is closed: anything not in your plugin folder, `data:` or
`blob:` fails to load, whatever your own CSP says, and the frame makes no connections, requests or
DNS lookups of its own. Links to other pages in your folder navigate the frame; for anything else
use `orca.shell.openExternal`, which needs a click and, for a web host your plugin has not opened
before, the person's OK in an Orca prompt that shows the URL (they can always allow that host). A file that is a custom editor's
`entry` gets the editor API; every other HTML page gets the panel API.

With isolated frames, scripts may be TypeScript or JSX with no build step: `<script type="module"
src="app.tsx">` loads `app.tsx` transpiled, with its relative imports resolved, as described in
[No build step](plugin-declarative-ui.md#no-build-step). A panel or custom editor `entry` may itself
be a `.ts` or `.tsx` module (needs `engines.orca` `>=1.4.246`); Orca then serves a page that loads
it, with an empty `<div id="root">`. Only components panels get JSX for `orca`; a frame that
uses JSX must bring its own runtime as relative files.

Browser clients (`orca serve` in a web browser) still load a frame as one sandboxed document
with an opaque origin and `connect-src 'none'`: inline your scripts and styles, use `data:` URLs
for images and fonts, and do not rely on storage, workers or WASM loaded by URL there.

A worker's `main` module's **default export** is `activate(orca)`, which Orca calls once when the
worker starts; it may be `async`. A named `export function activate` is not called: the worker
fails to start with an error saying so.
An optional `export function deactivate()` runs (and is awaited) before the worker stops, for
flushing state; the worker may also stop when it has been idle for a while, and starts again on
its next command, event or panel request.

```ts
import type { OrcaWorkerApi } from 'orca/worker'

export default async function activate(orca: OrcaWorkerApi) {
  orca.commands.register('hello', () => 'Hello from the worker')
}

export async function deactivate() {}
```

Workers get the same calls on the `orca` object passed to `activate(orca)`:
`orca.api`, `orca.host.call(method, params, { signal })`, `orca.host.has(method)`, plus
`orca.commands.register(id, (args, { signal }) => …)` and `orca.events.on(event, handler)`, which
both return `{ dispose() }`, and the panel and data APIs in
[Panels, workers and data](#panels-workers-and-data). A command's `signal` aborts when Orca stops waiting for it.
`orca.log(message)` writes to `orca plugin logs`. `orca.grantedCapabilities` is the frozen list of
capability kinds the user approved (such as `['storage:own']`), fixed when the worker starts; the
host still checks each call. In `agent.status.changed`, `state` and `mainAgent.state` are one of `working`, `blocked`, `waiting`
and `done`. Every event's payload is in the [host API reference](plugin-host-api.md#events).

To test a handler without reproducing the real trigger, fire the event at a development plugin:

```sh
orca plugin dev emit . workspace.created --data '{"workspaceId":"wt-1","kind":"worktree","path":"/repo","branch":"main"}'
```

It follows the normal rules: the plugin must be approved and granted the event's capability, and
`--data` is checked against the event's payload schema. The worker hears it when it lists the
event in `contributes.events` (it starts if it is not running), and each of the plugin's open
panels hears it once it has subscribed with `orca.on(event, …)`; with neither, it is refused.
Installed plugins are refused. `--json` prints `{ pluginKey, event, delivered: { worker, panels } }`.
A handler's errors land in `orca plugin logs` and `orca plugin dev watch`.

To call a worker's `orca.panels.handle(name, …)` handler without opening its panel, use
`orca plugin dev request . <name> --data '<json>'`. It goes through the same path as a panel's
`plugin.request` (approved development plugin with `main`; the worker starts if needed) and
prints `{ pluginKey, name, result }`. A handler failure exits `1` with `plugin_request_failed` and
the worker's code (`unknown_method`, `timeout`, ...) in `error.data.requestCode`.

A worker's `main` is an ES module: `.js`/`.mjs`, or `.ts`/`.mts` with no build step (needs
`engines.orca` `>=1.4.246`). Orca transpiles TypeScript files in your plugin folder as Node loads
them, keeping line numbers, so stack traces point at your `.ts` lines; enums and parameter
properties work too. JSX does not (no `.tsx` worker files). Relative imports resolve as in frames:
`./util`, `./util.js` and `./util.ts` all find `util.ts`, and `./store` finds `store/index.ts`.
Everything else, such as `node:` builtins, resolves exactly as Node resolves it for a JavaScript
worker. `orca/worker` holds only types, so import it with `import type`; a value import fails when
the worker starts.

### Panels, workers and data

A plugin's panels, custom editors and worker are one program. A panel asks its own worker, the
worker pushes back, and both read the same storage, settings and secrets (with the same
capabilities). Every surface spells it the same way: frames on `window.orca`, components panels
as imports from `orca`, workers on the `orca` from `activate`.

Declare the contract once, in a file both sides include, and both type-check against it:

```ts
// src/protocol.ts
export {}
declare module 'orca' {
  interface PluginRequests {
    'todos.list': { input: { done?: boolean }; output: Todo[] }
  }
  interface PluginPanelEvents {
    'todos.changed': { count: number }
  }
}
```

The worker answers and posts:

```js
export default function activate(orca) {
  orca.panels.handle('todos.list', async ({ done }, { panel, signal }) => list(done))
  // To every open panel of this plugin, or one: { panel: id } from a request's context.
  orca.panels.post('todos.changed', { count: 3 })
}
```

A panel asks and listens (in a frame, the same methods are on `orca.plugin`):

```ts
import { plugin } from 'orca'
const todos = await plugin.request('todos.list', { done: false }, { timeoutMs: 5000 })
plugin.on('todos.changed', ({ count }) => {})
```

- `plugin.request` starts the worker if it is not running, so a panel-only plugin can keep its
  logic in a worker that runs only while someone uses it. It needs `main` (`trusted-worker`).
- It rejects with `unknown_method` when no handler has that name, `timeout` past `timeoutMs`
  (default 30 s, at most 120 s; the handler's `signal` aborts then, and when the panel closes),
  `unavailable` when the worker cannot start, or the `code` the handler threw (`invalid_params`,
  `conflict` and the other host error codes; anything else is `action_failed`).
- Inputs and answers are JSON: an input up to 64 KiB, an answer up to 1 MiB. Posts are fire and
  forget, up to 256 KiB each and 200 per 10 seconds per plugin.
- Only the same plugin's panels and worker can reach each other.

Storage, settings and secrets are the plugin's own, shared by every surface:

```ts
import { atom, storage, settings, secrets } from 'orca'
await storage.set('filters', { done: false }) // storage:own
storage.onDidChange(({ key }) => {}) // any surface's write, the person's included
const url = await settings.get('apiUrl') // settings:own; declared ones read as their default
await secrets.set('token', value) // secrets:own
// A components atom kept in storage: the worker reads storage.get('todos') and its writes
// update the atom.
const todos = atom('todos', [], { persist: 'storage' })
```

Declare settings the person edits in `contributes.settings`; Orca shows them under the plugin in
its Settings and checks every value against the declaration:

```json
"settings": [
  { "key": "apiUrl", "title": "Server URL", "type": "string", "default": "https://example.com" },
  { "key": "pageSize", "title": "Page size", "type": "integer", "default": 20, "minimum": 1 }
],
"capabilities": [{ "kind": "settings:own" }]
```

`type` is `string`, `number`, `integer` or `boolean`; `enum` (with `enumLabels`), `minimum`,
`maximum`, `maxLength`, `multiline` and `placeholder` shape the control. A setting needs the
`settings:own` capability, which is also how code reads it.

Panels hear workspace and agent events the same way workers do, with the same capability:
`on('agent.status.changed', handler)` needs `agent:read`, the workspace events `workspace:read`.
A panel needs no `contributes.events` entry for that; it subscribes while it is open.

To show the workspace's agents, list them once with `agents.list` (`agent:read`), then follow
`agent.status.changed`. Both name each agent's terminal with `terminalId`, the id
`workspace.readContext` lists (with each terminal's `title`) and `terminal.sendText` takes; an
event's `paneKey` is Orca's own pane id. `workspace.changed` (`workspace:read`) carries the new
`workspace.readContext` answer whenever focus moves to another workspace or its terminals open,
close or are renamed, and once right when a panel or worker subscribes, so a panel never polls
and never starts out stale.

```ts
import { atom, host, on, read, set, update } from 'orca'
const agents = atom<{ terminalId: string | null; title: string | null; state: string }[]>([])
export async function setup() {
  set(agents, (await host.call('agents.list')).agents)
  on('agent.status.changed', ({ terminalId, title, state }) =>
    update(agents, (list) => [
      { terminalId: terminalId ?? null, title: title ?? null, state },
      ...list.filter((agent) => agent.terminalId !== terminalId)
    ])
  )
  on('workspace.changed', async () => set(agents, (await host.call('agents.list')).agents))
}
```

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

From the plugin folder, run:

```sh
orca plugin dev watch .
```

It writes the TypeScript typings (`.orca/types`), loads the folder into Orca as a development
plugin, and stays running: it prints every line your panels, editors and worker log (console
errors arrive as `[frame] <file>:<line> <message>`, at the line in your source file), a
`↻ reloaded` line each time a save reloads the plugin, and status changes such as `errored` or
`invalid` with the error. If an edit asks for new access, it prints the
`orca plugin dev reload <dir> --approve <fingerprint>` command to run from another terminal.
Ctrl-C unloads the folder (unless it was loaded before you started) and exits; press it again
to exit at once. With `--json` it prints one JSON object per line, with a `type` of `loaded`,
`log`, `reloaded`, `status`, `approval`, `check`, `shot`, `shot_skipped`, `warning`, `disconnected` or
`unloaded`, for coding agents. `--check` also runs `orca plugin check` after the load and after each reload and
prints what each components panel drew or threw, with `file:line:col`; it reports a failure while
Orca does not run the plugin (pending approval, errored, invalid), even when the panels render
(`ok` false, `checkOk` true, and `pluginStatus`). Like `orca plugin check`,
it runs your code on this machine outside Orca's sandbox, and it needs a local folder. When the first load needs approval and you run it in a terminal, it prints what the plugin
would be granted (execution, each capability, what it adds) and asks `Approve and load? [y/N]`;
`y` loads it with that approval and keeps watching. Any other answer, Ctrl-C, `--json`, or
output that is not a terminal (a coding agent, a pipe) fails like `orca plugin dev load`: it
exits with code 3 and prints the command to re-run with `--approve` (with `--json`, as one line).
It never approves on its own. The re-run owns the folder the refused attempt added, so its
Ctrl-C unloads it.

### See the panel

`orca plugin shot <plugin-key>` saves a PNG of a panel exactly as Orca draws it, cropped to the
panel, to `.orca/shots/<plugin-key>-<panel>.png` (or `--out <file>`): in the plugin folder when
you run it inside one (the nearest `orca-plugin.json`, up to the repository root), else in the
current folder. It opens the panel in the
right sidebar, waits until the current code has drawn (a components panel's first tree, an HTML
panel's page loaded; up to 15 seconds) and, for a components panel, until its host calls such as
`plugin.request` have answered and redrawn (at most 3 seconds more), and captures it even while Orca's window is hidden or
behind others, without showing, raising or focusing it. `--width <px>` sizes the panel for that
capture only. `--theme light|dark` paints Orca in that mode for that capture only, and only while
its window is hidden or minimized: with the window on screen, the shot keeps the current theme
rather than repaint the app in front of you, and says so (`themeApplied: false` and a
`themeReason`). Your width and theme setting are always put back. `--json` prints `{ path, width,
height, theme, themeApplied, themeReason?, settled, errors, pendingRequests?, actions?,
restored? }`, where `errors` holds the error banner the panel shows and the errors it logged
during the capture, and `pendingRequests` counts host calls still unanswered (above 0, the image
may show the panel still loading). A coding agent reads the
image to see what it built.

`--act '<json>'` drives a components panel before the capture, with the test kit's verbs: a list
(at most 20) such as `[{"type":{"label":"New task"},"text":"Ship","submit":true},
{"press":{"text":"Add"}},{"select":{"label":"View"},"value":"done"},{"toggle":{"label":"Hide
done"}}]`, whose queries match like the kit's (`text`, `label`, `testId`, `type`, `role`). The
kit's Slider, Table and Tree verbs work too: `{"slide":Q,"value":7}`, `{"sort":Q,"column":"name"}`,
`{"selectRows":Q,"keys":["a"]}`, `{"activateRow":Q,"key":"a"}`, `{"loadMore":Q}`, and
`expand`, `collapse`, `selectItem`, `activateItem` with a `key`. Each act goes through Orca's own
control, as your typing or click would, and waits for the panel to redraw and its host calls to
answer. `actions` in the result has one `{ ok, error? }` per act; the first failure skips the
rest, the PNG shows the panel at that point, and the command exits 1. Once captured, Orca puts
the panel's atoms back, persisted ones included, so later shots and you see the panel as it was
(`restored: true`; false when it reloaded during the acts). What handlers did outside the panel
is not rolled back: a press whose handler sends `plugin.request('counter.add')` leaves the
worker's storage changed. It acts only on that
plugin's panel and only while Orca's window is hidden or minimized, so it never clicks under you;
html panels refuse it. An act is not a person's press: a Link's href stays unopened and calls
that need a gesture (`shell.openExternal`, `files.saveAs`) are refused.

`orca plugin shot <dir> --scenario <name>` shoots the panel in one scenario of its
`<entry>.check.ts` (see check fixtures) instead of the live panel. The CLI renders that scenario
the way `orca plugin check` does, with the panel and its worker against a stand-in host, so the
scenario's data never reaches the plugin's real panel, storage, settings or worker. Orca then
draws the resulting tree in a preview of its own, apart from the plugin, and captures it; the
right sidebar is not opened or switched. Like `orca plugin check`, it runs the plugin's code on
your machine without Orca's sandbox, so use it only on code you trust. Pass the plugin folder,
or a development plugin's key when you run it inside that folder; installed plugins are refused.
The result adds `replay: true` and `scenario`, `errors` lists what the render reported, and an
unknown name fails and lists the panel's scenarios. A replay is a still frame: controls whose
value Orca owns start from the tree's props, images show their placeholder, it takes no `--act`,
it works only on this machine (no `--environment`), and it needs Orca's window hidden or
minimized because the preview is drawn inside it. It writes
`.orca/shots/<plugin-key>-<panel>.<scenario>.png` in the plugin folder unless you pass `--out`.

`orca plugin dev watch . --shot ./.orca/shots` opens one panel (the first, or
`--shot-panel <id>`) in the right sidebar once, then after the load and after each reload that
leaves the plugin running saves a fresh `<plugin-key>-<panel>.png` of it; with `--check`, the
check runs first. It never switches the sidebar again: while you show another tab or close the
sidebar it skips the shot and says so once (`shot_skipped`), and resumes when the panel is back.

`orca plugin open <plugin-key> [--panel <id>]` shows a panel to you in the right sidebar, and
`--editor <file>` opens a file in the plugin's custom editor. It never brings the window forward.

Both need the Orca desktop app with a workspace showing; `orca serve` has no window and refuses
them. A shot never changes the view, so while Orca shows Settings or another full page it fails
with `no_workspace`. With `--environment`, the PNG (at most 5 MiB) comes back to the machine
that ran the command.

To keep a folder loaded without a terminal, use Settings instead:

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
each change to them is reviewed again. **Restart** on the plugin row restarts a worker by hand,
and the plugin's logs show what it printed. `orca plugin dev reload [<dir>]` reloads
now, for a change the watcher missed (network or WSL folders) or after changing commands or
shortcuts, which need a new approval (`--approve <fingerprint>`).

A components panel hot reloads on save, keeping its keyed atoms and, when a save does not load,
its last good version with the error inline ([hot reload](plugin-declarative-ui.md#hot-reload)).
A running worker restarts on the new code; what it keeps in `storage` is on disk, so it survives
the restart, while its in-memory state does not.

For TypeScript, run `orca plugin types <dir>` once (or let `orca plugin dev load` do it): it
writes Orca's typings and a tsconfig to extend into `.orca/types/`, which ignores itself in Git.
They cover every surface: the components `orca` module, the global `orca` (`window.orca`) of
panels and custom editors, and `import type { OrcaWorkerApi } from 'orca/worker'` for a worker's
`activate(orca)` (in JavaScript, `/** @param {import('orca/worker').OrcaWorkerApi} orca */`).
`orca.host.call` checks each method's params and result, and only offers the methods your
surface may call; `orca.events.on` types each [event payload](plugin-host-api.md#events).
Development folders skip their top-level `.orca/` and `node_modules/` (they never count toward the
size limits below there, and editing them never re-reviews the plugin or remounts its frames); an install still
hashes every file it copies, so do not commit them.

A plugin folder holds at most 2,000 files and 50 MiB in total. A panel or custom editor `entry`
is at most 10 MiB, and each `.ts`, `.tsx`, `.mts` or `.jsx` file Orca transpiles at most 1 MiB;
bundle or split anything larger.

In the desktop app, a panel's or custom editor's `console.error` and `console.warn`, uncaught
exceptions and unhandled rejections (and a components panel's render or mount errors) also land
in `orca plugin logs`, as `[frame] <file>:<line> <message>` with the path relative to the plugin
folder and stack traces shortened the same way. At most 20 such lines per plugin every 10 s are
kept; past that one notice is logged and the rest are dropped. `orca plugin dev inspect
<publisher.id>` opens DevTools for each of the plugin's open frames.

## 3. Validate

```sh
pnpm validate:plugin path/to/plugin
# or, without an Orca checkout:
orca plugin validate path/to/plugin
```

`orca plugin create <dir> --template <theme|terminal-theme|icon-theme|syntax|language-pack|editor|panel|components|worker-panel>`
scaffolds a plugin that passes these checks, and `orca plugin inspect <dir>` shows what it would be
allowed to do and its content hash.

This runs the manifest checks Orca runs, strictly: unknown keys, limits, contributions beyond the
execution profile, an `engines.orca` too low for the fields used, and that every file the
manifest names (icon, panel and editor entries, themes, syntaxes, translations, templates)
exists inside the plugin and fits its size limit. On a catalog it also
checks that listed images exist and fit. It warns when the manifest still declares the deprecated
`publisher`, and, in a Git repository, when that value is not the owner of the `origin` remote.
Warnings do not fail the check. Run it in CI for the plugin and catalog repositories.

The two report failure with different exit codes. `pnpm validate:plugin` exits `0` when every
file is valid, `1` when any is invalid or missing, and `2` when no path is given.
`orca plugin` commands exit `0` ok, `1` error (such as a missing path), `2` the plugin is
invalid (`plugin_invalid`), and `3` approval is needed.

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

1. Commit the plugin and run `orca plugin release-entry .` in its directory (or
   `pnpm validate:plugin path/to/plugin` from an Orca checkout). It prints the
   release entry for `HEAD`: version, full commit SHA, `contentHash`, execution profile, minimum
   Orca, contribution summary, capabilities and file types, plus the `source.path` when the plugin
   is a subdirectory of its repository. Every field must match
   what Orca finds at install, so paste it rather than writing it by hand. Uncommitted changes are
   not part of the entry.
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

`skills`, `mcpServers` and `hooks` will mean what they mean in agent-plugin formats such as
Claude Code's. Orca does not reserve `agents`, because those formats use it for subagent files.

See [the manifest reference](plugin-manifest.md#planned-contribution-points) for details.

## Stability

Plugins are in Alpha: the manifest v2 format and catalog format are stable contracts; items
listed as experimental may change. These parts are stable and change only additively:

- manifest format 2, capability names and execution profiles;
- host API 1 (`"pluginApi": 1`): method names, params, results, surfaces and error codes;
- the frame API `window.orca` (`api`, `host.call`, `host.has`, `on`, `shell.openExternal`,
  `files.saveAs`, and `document` in custom editors) and the document `version`/`content` shape;
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
- `pnpm validate:plugin` output; only its exit codes (`0` valid, `1` invalid, `2` usage, see
  [Validate](#3-validate)) are stable;
- `settings:own`, which stores untyped values until plugins can declare settings;
- manifest format 1, which is deprecated. Catalogs need format 2.

Data folders, `orca-plugin-image://` URLs, tab keys and the `pluginRoot` a worker receives are
internal.
