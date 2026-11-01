# Plugin dev loop, shots, tests and checks

Hand-written companion to the `orca-plugin-authoring` guide. `ORCA` is the Orca executable you
resolved; pass `--json` and branch on `error.code`.

## dev watch

`ORCA plugin dev watch <dir> [--check] [--shot <out-dir> [--shot-panel <id>]] [--approve <fp>] --json`
loads the folder (refreshing `.orca/types`) and prints one JSON object per line:

- `loaded`, `unloaded`, `disconnected`, `warning`.
- `log`: what panels, editors and the worker print. Console errors and uncaught exceptions read
  `[frame] <file>:<line>:<col> <message>` at your source position, with engine frames such as
  `Array.forEach (<anonymous>)` dropped. A `[frame]` line repeated within one reload prints once
  (`count`: copies that came together, shown `×N`); later copies arrive as one `repeat: true`
  line with their `count` at the next reload or when the watch ends.
- `reloaded` (before that reload's logs) and `status` (`errored`/`invalid` with the error).
- `approval`: an edit asked for new access; it carries the `dev reload … --approve` command to
  show the user. The watch keeps running and never approves.
- `check` (with `--check`): `orca plugin check` after the load and each reload. `ok` is false
  unless Orca also runs the plugin; `checkOk` is the check alone, `pluginStatus`/`pluginError`
  what Orca reports.
- `shot` (with `--shot`): `{ path, width, height, settled, errors }` for the panel opened once at
  start (the first, or `--shot-panel <id>`). Read the PNG. `shot_skipped` means the user switched
  the sidebar away: leave it, shots resume when they show the panel again.

A first load that needs consent prints one error line and exits `3`; re-run with `--approve`
(Ctrl-C still unloads the folder the refused attempt added). Ctrl-C unloads only what this watch
loaded; a second Ctrl-C exits at once.

Off the watch: `ORCA plugin logs <plugin-key> --json` (the same lines), `ORCA plugin restart
<plugin-key>` (reruns a worker's startup code), `ORCA plugin dev reload <dir>` (a missed save, or
re-checks changed commands and shortcuts), `ORCA plugin dev unload <dir>`.

## Seeing and showing the panel

- `ORCA plugin shot <plugin-key> [--panel <id>] [--theme light|dark] [--width <px>] [--out <png>] --json`
  waits for the panel's current code to draw and, for a components panel, for its host calls
  (`plugin.request` included) to answer and redraw (at most 3s more), then writes a PNG cropped to
  it (default `.orca/shots/<plugin-key>-<panel>.png` in the plugin folder when run inside one, else
  in `<cwd>`) and returns `{ path, width, height, theme, themeApplied, themeReason?, settled,
  errors, pendingRequests?, actions?, restored? }`. `pendingRequests` above 0 means a worker had
  not answered, so the PNG may show the loading state. Check a narrow `--width` and both themes. `--theme` applies only while Orca's
  window is hidden or minimized; otherwise `themeApplied` is false with a `themeReason`, so
  nothing on the user's screen repaints.
- `--act '<json>'` drives a components panel before the capture, in the test kit's verbs:
  `[{"type":{"label":"New task"},"text":"Ship","submit":true},{"press":{"text":"Add"}},
  {"select":{"label":"View"},"value":"done"},{"toggle":{"label":"Hide done"}}]` (at most 20;
  queries take `text`, `label`, `testId`, `type`, `role`). Also `{"slide":Q,"value":7}`, for a
  Table `{"sort":Q,"column":"name"}`, `{"selectRows":Q,"keys":["a"]}`,
  `{"activateRow":Q,"key":"a"}`, `{"loadMore":Q}`, and for a Tree `{"expand":Q,"key":"src"}`,
  `collapse`, `selectItem`, `activateItem` (same `key`). Each act goes through Orca's own control,
  then waits for the panel to redraw and its host calls to answer; `actions` has one
  `{ ok, error? }` each, the first failure skips the rest and exits 1. After the capture the
  panel's atoms are put back, persisted ones included (`restored`; false if it reloaded
  meanwhile), but not what handlers changed elsewhere: a `plugin.request` that wrote worker
  storage stays written. It needs Orca's window hidden or minimized, so it never
  clicks under the user, and refuses html panels. Acts are not a person's press: a Link's href
  stays closed and `shell.openExternal` / `files.saveAs` are refused.
- `ORCA plugin shot <dir> --scenario <name> [--panel <id>] [--theme] [--width] [--out]` shoots
  one scenario of the panel's `<entry>.check.ts` instead of the live panel: the CLI renders it
  as `plugin check` does (the panel and the worker against a stand-in host, so the scenario's
  data never reaches the real panel, storage, settings or worker), then Orca draws that tree in
  a preview apart from the plugin and captures it; the sidebar is not opened or switched. It
  runs the plugin's code on this machine, unsandboxed, like `plugin check`. A key works only for
  a dev plugin, run inside its folder. The result adds `replay: true` and `scenario`, and
  `errors` has what the render reported; an unknown name fails and lists the scenarios. Limits:
  a still frame (host-owned control values start from the tree's props), images show their
  placeholder, no `--act`, local only (no `--environment`), and Orca's window must be hidden
  or minimized. Default file `.orca/shots/<plugin-key>-<panel>.<scenario>.png`.
- `ORCA plugin open <plugin-key> [--panel <id> | --editor <file>]` shows the panel in the right
  sidebar, or a file in the plugin's custom editor. Neither raises the window.
- Both need the desktop app with a workspace showing. A shot never changes the view: it fails with
  `no_workspace` while Orca shows Settings or another full page. Without them, use `plugin check`.

## Events

`ORCA plugin dev emit <dir|plugin-key> <event> --data '<json>'` fires a test event under the real
rules (approved dev plugin, the event's capability, payload checked against its schema). The
worker hears it when it lists the event in `contributes.events`; each open panel hears it once it
called `orca.on(event, …)`. Nothing listening is refused. Handler errors arrive as `log` lines.

`ORCA plugin dev request <dir|plugin-key> <name> --data '<json>'` calls the worker's
`orca.panels.handle(name, …)` handler the way a panel's `plugin.request` does (approved dev plugin
with `main`; the worker starts if needed) and prints `{ pluginKey, name, result }`. A failure is
`plugin_request_failed` with the worker's code in `error.data.requestCode` (`unknown_method`,
`timeout`, ...). `--panel <id>` sets the caller panel id; `--timeout-ms` the handler's deadline.

## test and check

Both run the plugin's code on this machine, outside Orca's sandbox: only on code you trust.

- `ORCA plugin test [dir] --json` runs every `*.test.ts(x)` (also `.mts`, `.js(x)`, `.mjs`),
  skipping `node_modules`, `.orca`, `dist` and dot-folders, with `node:test` or the plugin's own
  vitest. Stdout is `{ ok, result: { runner, code, node: 'system' | 'orca', files } }`; the exit
  code is the runner's (`plugin_tests_failed`).
- `ORCA plugin check [dir] --json` validates, then renders each components panel once against a
  stand-in host with the manifest's capabilities: what it threw (`file:line:col`), layouts Orca
  would refuse, props it would drop, and host calls Orca would refuse (`host refused …` warnings,
  even when the panel caught the error). With a worker (`main`), it mounts the worker on the same
  host first, so the panel's `plugin.request` reaches its `orca.panels.handle` handlers; a worker
  that fails to activate is an issue named `worker (<file>): …`. Each result carries a `summary`
  of what drew (headings, callouts, empty states, table sizes, the selected tab) and, with
  `--json`, the whole `tree`: read them to confirm each scenario shows what it should. Exit `0`,
  `1` `plugin_check_failed`, `2` invalid.

The full kit API, generated from this Orca, is in `references/testing.md`.

### Check fixtures

Check renders against an empty host (no agents, no storage) unless the panel has scenarios. Put
them beside its entry (`src/panel.check.ts` for `src/panel.tsx`); check renders the panel once per
scenario, each on a fresh host with the worker, and labels each result with `scenario`:

```ts
import { defineCheck } from 'orca/testing'

export default defineCheck({
  empty: {},
  busy: {
    results: {
      'agents.list': {
        agents: [
          {
            terminalId: 't1',
            title: 'Claude',
            agent: 'claude',
            state: 'working',
            stateStartedAt: 0
          }
        ]
      }
    },
    settings: { notifyOnBlocked: true },
    events: [
      {
        event: 'agent.status.changed',
        payload: {
          workspaceId: null,
          paneKey: 'p',
          terminalId: 't1',
          state: 'blocked',
          receivedAt: 0
        }
      }
    ]
  }
})
```

- A scenario takes `mockHost()` options (`results`, `requests`, `storage`, `settings`, `secrets`,
  `capabilities`), plus `persisted` and `theme` as `mount()` takes them, and `events` delivered in
  order after the first draw. `requests` stubs a name; any other goes to the worker.
- Add one per state worth seeing: empty, busy, an error answer (`hostError(code)` in `results`).
- Orca itself never loads `*.check.ts`; it may import `orca/testing`.

### Panels with orca/testing

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

- `mount(module, { host, theme, locale, visible, panelId, persisted })` runs `setup`, renders and
  resolves once drawn; every mount resets every atom; one panel at a time. `stored(value,
  version)` seeds what an older version wrote, to test `migrate`.
- `find` (innermost match or `null`) and `findAll` take `type`, `role`, `text`, `label` or
  `testId` (the element's `key`); `text` and `label` match exactly, so use a RegExp for part.
- `press`, `type(el, text, { replace?, submit? })`, `submit`, `toggle`, `select(el, value)` resolve
  once renders, host calls and persisted writes settle: `await` them, never sleep. `valueOf`,
  `tree()`, `errors`, `warnings`, `persisted` inspect.
- `mockHost({ capabilities, results, requests, storage, settings, secrets })` (pass as `host`)
  refuses what Orca refuses: undeclared capabilities, bad params, and `shell.openExternal` or
  `files.saveAs` without a `press`. `results` may throw `hostError(code)`; `callsOf(method)` and
  `host.data()` read back calls and data. `requests` fakes the worker for `plugin.request`;
  `panel.post(event, payload)` is a worker post, `panel.emit` an Orca event.
- `panel.refusals` (and `host.refusals`) lists calls Orca would refuse, with their `code`, even ones
  the code caught: assert it is `[]`.
- Mount the module, never call its default export. A control with `value` but no `onChange` is
  read-only, so `type`/`toggle` throw on it.

### Workers with orca/testing

`mountWorker(main, { host, events, commands })` calls the module's default-exported
`activate(orca)` with Orca's worker `orca` backed by `mockHost`, loading `.ts` mains as Orca does.

```ts
import { assert, mountWorker, test } from 'orca/testing'
import * as main from './worker'

test('answers the panel and notifies on blocked agents', async () => {
  const worker = await mountWorker(main)
  assert.deepEqual(await worker.request('todos.list'), [])
  await worker.emit('agent.status.changed', {
    workspaceId: null,
    paneKey: 'tab-1:pane-1',
    state: 'blocked',
    receivedAt: 1
  })
  assert.equal(worker.host.callsOf('notifications.show').length, 1)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
```

- Its `activate(orca)` must be the module's default export. Events, commands and capabilities
  default to the manifest's (`mountWorker(main, { host, events, commands })` overrides).
- `emit` delivers only events `contributes.events` lists, checks the payload and waits for every
  handler. `request(name, input, { panel })` is a panel's `plugin.request` answered by
  `orca.panels.handle`; `posts` records `orca.panels.post`; `command(id, args)` runs a registered
  command; `logs` holds `orca.log` lines; `refusals` the host calls Orca would refuse (assert `[]`);
  `deactivate()` runs the module's `deactivate`.
- Seed storage, settings and secrets with `mockHost({ storage, settings, secrets })` as `{ host }`;
  a panel mounted on the same host sees the same data.
