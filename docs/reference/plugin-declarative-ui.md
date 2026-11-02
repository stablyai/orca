# Components panels (TSX)

A components panel describes its UI as data; Orca draws it with its own controls, so it matches the
app in light and dark, follows its keyboard and focus rules, and needs no HTML or CSS. Design contract:
[plugin-isolated-frames.md](./plugin-isolated-frames.md).

## Manifest

```json
{
  "execution": "sandboxed-ui",
  "engines": { "orca": ">=1.4.246" },
  "contributes": {
    "panels": [{ "id": "todos", "title": "Todos", "entry": "src/panel.tsx", "ui": "components" }]
  }
}
```

`ui` defaults to `html` (a web page in an isolated frame). With `components`, `entry` is an ES module:
`.tsx`, `.ts`, `.jsx` or `.mts` with no build step, or a bundled `.js`/`.mjs`. `ui` and build-less
entries arrived in Orca 1.4.246, so declare at least that in `engines.orca`; an older Orca then says
which release the plugin needs.

## Writing a panel

```tsx
import { atom, read, set, update, Stack, Text, Button } from 'orca'

const count = atom('count', 0, { persist: 'plugin' })

export default function Panel() {
  return (
    <Stack gap="sm">
      <Text>Clicked {read(count)} times</Text>
      <Button onPress={() => update(count, (n) => n + 1)}>Click</Button>
      <Button variant="ghost" onPress={() => set(count, 0)}>
        Reset
      </Button>
    </Stack>
  )
}
```

- The default export must be a component function; it is mounted as the panel. `mount(Component)` does
  the same explicitly.
- Catalog components are imported from `orca` by name. They are JSX tags only, and lowercase tags such as
  `<div>` do not exist.
- Function components take props and `children` as in React. There are no hooks: keep state in atoms.
- Props are plain JSON data (strings, finite numbers, booleans, null, arrays, plain objects) or event
  handler functions. Anything else (a `Date`, a `Map`, a class instance) is reported as an error and the
  render is not shown.
- `key` works as in React. Give items of lists that reorder a `key`; siblings must not share one.

## State

- `atom(initial)` holds state for this panel run.
- `atom(key, initial, { persist, version, migrate })` is named, unique per plugin, and may persist:
  `persist: 'memory'` (default; this panel run, plus [hot reloads](#hot-reload) in development),
  `'plugin'` (every run of the plugin) or `'workspace'` (per Orca
  workspace; switching workspaces swaps the values). Persisted values must be plain JSON, load before the
  first render, are saved shortly after they change, and live in the plugin's own data folder; no
  capability is needed. When the stored shape changes, bump `version`; `migrate(stored, fromVersion)` turns
  an older value into the new shape, and without it the atom starts from `initial`.
- `persist: 'storage'` keeps the atom in the plugin's own storage under its key (the `storage:own`
  capability): the worker reads the same value with `orca.storage.get(key)`, and a write from the
  worker or another panel updates the atom. Values are stored as they are, so `version` and
  `migrate` do not apply; atoms the module creates on load have their value before the first render.
- `derived(() => ...)` computes from other atoms; it is read-only.
- `read(atom)` reads; reading while rendering subscribes the panel to it.
- `set(atom, value)` stores a value as is, functions included; `update(atom, (previous) => next)` derives
  the next one. Both are batched (about one render per frame) and throw while rendering.

## Lifetime

The module runs while its panel is the open right-sidebar tab, including while the sidebar is collapsed or
Orca's window is hidden. Switching to another tab, closing the panel, disabling the plugin or reloading it
ends the run; only persisted atoms carry over to the next one.

An optional `setup` export runs once, after persisted atoms load and before the first render:

```ts
import { on, read, type PanelContext } from 'orca'

export function setup(ctx: PanelContext) {
  ctx.subscriptions.push(on('theme', ({ colorScheme }) => console.log(colorScheme)))
  // ctx.signal aborts, and ctx.subscriptions are disposed, when the run ends.
  // read(ctx.visible) is true while the person can see the panel.
  return () => {
    // Also runs when the run ends.
  }
}
```

Cleanup runs when the panel reloads or navigates; when a panel is closed its process ends with it, so do
not rely on cleanup to save anything: persist it in an atom.

## Talking to Orca

The `orca` module has the same facade as frame panels:

- `host.call(method, params, { signal, timeoutMs })`, typed from the host API (see
  [plugin-host-api.md](./plugin-host-api.md)); rejections carry a `code` such as `timeout` or
  `capability_denied`. `host.has(method)` says whether this Orca offers a method to the panel.
- `api` is `{ major, minor }` of the host API.
- `env.locale` is Orca's UI language, `env.theme` is `{ colorScheme }` (reading it while rendering
  re-renders on a switch) and `env.client` is `'desktop'`.
- `shell.openExternal(url)` and `files.saveAs({ suggestedName, mimeType, data })` are shorthands for
  `host.call('shell.openExternal' | 'files.saveAs', ...)` and resolve with the same result. They follow
  the user-gesture rule below; the hidden module has no `window.orca.shell` or `window.orca.files`.
- `on(event, handler)` returns a `Disposable`. Events are typed (`OrcaEvents`); Orca's own panel messages
  are not events and `on()` refuses them.
- `ui.catalog` is a number that grows with the component catalog; `ui.has(component, prop?)` says
  whether this Orca draws a component or accepts a prop on it.
- `plugin.request(name, input)` and `plugin.on(event)` talk to the plugin's own worker;
  `storage`, `settings` and `secrets` are the plugin's own data; `on('agent.status.changed')` and
  the workspace events arrive with their read capability. See
  [Panels, workers and data](./plugin-authoring.md#panels-workers-and-data).

## Hot reload

In a development folder, saving a file reloads the panel in place:

- Keyed atoms carry over. Persisted ones reload as always; keyed `memory` atoms (`atom('draft', '')`)
  are handed to the new module, so a half-typed draft or the open tab survives the save. An atom whose
  `version` changed starts from `initial` (`migrate` is not called), and so does one holding something
  other than plain JSON (a function, a `Map`). Unkeyed `atom(initial)` state, module variables and
  `setup` start over; `setup`'s cleanup runs for the old module.
- A brief **Reloaded** mark shows in the panel's corner.
- A save that fails to load (a syntax error, an import Orca refuses, or a module that throws before
  its first render) keeps the last version that loaded on screen, with an inline error naming
  `file:line:column` and the message; the same line is in `orca plugin logs`. Until the next save
  loads, that last tree does not respond to clicks. The next save that loads replaces it and clears
  the error. Lines are your source's; a column can be off on a line that had types or JSX.

Installed plugins remount from scratch on an update; only persisted atoms carry over.

## No build step

Orca transpiles `.tsx`, `.ts`, `.jsx` and `.mts` files when the panel loads, so a plugin ships its
source and no `dist/` folder: edit, save, and the panel [hot reloads](#hot-reload).

- Types are stripped and JSX compiles for `orca` (automatic runtime). Lines are kept and an inline
  source map covers columns, so an error's `file:line:column` in the panel, `orca plugin logs` and
  `orca plugin check` is the same position in your source (`orca plugin logs` leaves out Orca's own
  runtime frames). A file that does not transpile reports `src/panel.tsx:4:7: Unexpected token`.
- Relative imports resolve to exact files: `./todos` finds `todos.tsx`, `todos.ts`, `todos.jsx`,
  `todos.js`, then `todos/index.*`, and `./todos.js` finds `todos.ts` as TypeScript expects.
- Only `orca`, `orca/*` and relative files can be imported. A bare package such as `react` fails with
  an error naming the file and the import: copy the package's ESM files into the plugin and import
  them by relative path, or bundle (below).
- Transpiling is syntax only: it never type-checks. Each source file is capped at 1 MiB and
  2 s of transpiling, which runs off Orca's main thread.
- TypeScript features that need type information to compile, such as `const enum` across files and
  `export =`, are not supported; `isolatedModules` in the generated tsconfig flags them.

Types: `orca plugin types .` writes Orca's typings and a tsconfig to `.orca/types/` (`orca plugin
dev load` refreshes them), and `.orca/` ignores itself in Git. Extend it:

```json
{ "extends": "./.orca/types/tsconfig.json", "include": ["src"] }
```

Then `npx tsc -p .` type-checks. `orca plugin create <dir> --template components` scaffolds all of
this. [`examples/plugins/hello-tsx`](../../examples/plugins/hello-tsx) is a complete sample.

### Bundling instead

A bundled `.js` entry still works, for example to use npm packages. `orca` is provided by Orca at
runtime, so leave it out of the bundle:

```sh
esbuild src/panel.tsx --bundle --format=esm --jsx=automatic --jsx-import-source=orca \
  --external:orca --external:'orca/*' --outfile=dist/panel.js
```

`/** @jsx h */` with `import { h, Fragment } from 'orca'` (classic `jsxFactory`) also works when you
bundle. [`examples/plugins/hello-components`](../../examples/plugins/hello-components) has a build
script.

## Testing

`orca plugin test [dir]` runs the plugin's `*.test.ts(x)` files in plain Node, with no Orca window:
Node's built-in runner (`node:test`), or the plugin's own vitest when it has one installed. `orca` and
`orca/testing` resolve to the files this Orca ships, and the plugin's sources are transpiled and
resolved exactly as Orca loads them, so a test runs the code Orca runs. The exit code is the runner's.

```tsx
import { assert, mount, test } from 'orca/testing'
import * as panel from './panel'

test('adds a task', async () => {
  const view = await mount(panel, { persisted: { plugin: { todos: [] } } })

  await view.type({ label: 'New task' }, 'Ship it', { submit: true })

  assert.ok(view.find({ role: 'button', text: /Ship it/ }))
  assert.deepEqual(view.persisted.plugin.todos, [{ id: 1, title: 'Ship it', done: false }])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
```

- `orca/testing` also exports Node's `test`, `describe`, `beforeEach`, `afterEach` and strict `assert`,
  so tests type-check without `@types/node`. With vitest, use vitest's own `test` and `expect`.
- `mount(module | Component, options)` boots the panel with the real runtime (persisted atoms, `setup`,
  then the first render) and resolves once it has drawn. Options: `host`, `theme`, `locale`,
  `visible`, `panelId`, and `persisted` (`{ plugin, workspace }` by atom key; `stored(value, version)`
  for a value an older version wrote, to test `migrate`). Each mount starts every atom from its
  initial value; one panel is mounted at a time.
- Find with `find(query)` (the innermost match, or `null`) and `findAll(query)`. A query matches on
  any of `type`, `role`, `text`, `label` (a control's `label`, a list item's or card's `title`) and
  `testId` (the element's `key`); `text` and `label` match exactly or by RegExp.
- Act with `press`, `type(el, text, { replace?, submit? })` (Input, Textarea), `submit`, `toggle`
  (Switch, Checkbox, Collapsible), `select(el, value)` (Select, RadioGroup, Tabs) and `slide(el, n)`
  (Slider), on an element or a query. Tables take `sort(el, column)`, `selectRows(el, keys)`,
  `activateRow(el, key)` and `loadMore(el)`; Trees take `expand`/`collapse(el, key)`,
  `selectItem(el, key)` and `activateItem(el, key)`. Each act resolves once the panel has settled: its
  renders, its host calls and its persisted writes. `valueOf(el)` is what Orca shows in a value control,
  with the same edit protocol as Orca; `rowsOf(table)` and `expandedOf(tree)` read a Table's row order
  and a Tree's open items.
- Finders see what Orca draws: the content of an unselected tab or a closed `Collapsible` is not
  there until a `select` or `toggle` shows it.
- Inspect `tree()` (plain data for snapshots, handlers shown as `[handler]`), `errors` (what the panel
  threw, with its stack, and renders Orca would refuse), `warnings` (props and components Orca would
  drop) and `persisted` (`plugin`, `workspace`, and the plugin's `storage`). `emit(event, payload)`
  delivers `theme` or a workspace or agent event, `post(event, payload)` is the worker's
  `orca.panels.post` (what `plugin.on` hears), and `setVisible`, `rerender` and `settled` drive the
  rest; `unmount()` ends the run, running `setup` cleanup.
- `mockHost({ capabilities, results })` stands in for Orca's host. It refuses what Orca refuses, with
  the same error codes: a method panels cannot call, a capability the manifest does not declare
  (capabilities default to the manifest's), bad params, and `shell.openExternal` or `files.saveAs`
  without a press first (each `press` grants one). `results` maps a method to a value or to a function
  of its params, which may throw `hostError(code)`; `calls` and `callsOf(method)` record every call.
  The stationary-control rule for gestures is not simulated.
- The mock host keeps the plugin's storage, settings and secrets in memory (seed them with
  `mockHost({ storage, settings, secrets })`, read them with `host.data()`), so `storage`,
  `settings`, `secrets` and `persist: 'storage'` atoms work under `mount()`, and a write reaches
  `onDidChange` as in Orca. `requests` stands in for the worker: each `plugin.request` name maps to
  its answer or a function of the input (which may throw `hostError(code)`); an unlisted name is
  `unknown_method`. Both follow your `PluginRequests` types.
- `refusals` (on the mounted panel and on the host) lists every call Orca would refuse, as
  `{ method, code, message }`, even when the panel caught the error: a `.catch()` around a call
  that is missing its capability passes every other assertion, so assert `refusals` is empty.

### Testing a worker

`mountWorker(module, { host, events, commands })` runs a worker's `main` the way Orca does: it calls
the module's default-exported `activate(orca)` with a worker `orca` object backed by `mockHost`
(worker methods and the manifest's capabilities). `.ts` and `.mts` mains, their relative imports
and `node:` or package imports load as Orca's worker host loads them, and importing `orca` at run
time fails with Orca's message (`orca/worker` is types only).

```ts
import { assert, mountWorker, test } from 'orca/testing'
import * as main from './worker'

test('notifies when an agent is blocked', async () => {
  const worker = await mountWorker(main)
  await worker.emit('agent.status.changed', {
    workspaceId: null,
    paneKey: 'tab-1:pane-1',
    state: 'blocked',
    receivedAt: Date.now()
  })
  assert.equal(worker.host.callsOf('notifications.show').length, 1)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
```

- `emit(event, payload)` delivers an event only if `contributes.events` lists it (events default to
  the manifest's), checks the payload against Orca's schema, and resolves once every handler and
  host call has finished.
- `command(id, args)` runs a registered command. Registering an id the manifest does not list fails
  activation, as it stops the worker in Orca.
- `logs` holds what the worker passed to `orca.log`; `refusals` and `host.calls` record host calls.
- `deactivate()` runs the module's `deactivate` export and drops its handlers.
- `request(name, input, { panel })` calls the handler the worker registered with
  `orca.panels.handle(name, ...)`, as a panel's `plugin.request` reaches it (an unhandled name is
  `unknown_method`); `posts` records `orca.panels.post` calls.
- `orca.storage`, `settings` and `secrets` use the mock host's in-memory store, so seed them with
  `mockHost({ storage, settings, secrets })` and read them back with `host.data()`; a panel mounted
  on the same host sees the same data.

`orca plugin check [dir]` validates the plugin like `orca plugin validate`, then renders every
components panel against `mockHost()` and reports what the panel threw (with `file:line`), layouts
Orca would refuse, props it would drop, and host calls Orca would refuse (a warning even when the
panel caught the error). Repeated identical issues are reported once. Each result says what the
panel drew in a few lines (`summary`: headings, callouts, empty states, table and tree sizes, the
selected tab, loading placeholders, danger or warning text), and `--json` adds the whole drawn
`tree`, so a scenario can be read without opening Orca. When the plugin has a worker
(`main`), check mounts it on the same host first, so the panel's `plugin.request` reaches its
`orca.panels.handle` handlers as in Orca; a worker that fails to activate is reported as an issue
named after its file. Both commands run the plugin's code on your machine with your full access,
outside Orca's sandbox, so run them only on code you trust. They use the `node` on PATH when it is
20.6 or newer (the first with `module.register`), else the Node built into Orca, so authors need no
Node install.

### Check scenarios

By default check renders each panel once, against an empty host: no agents, no storage. To check
the states that matter, put named scenarios beside the panel's entry (`src/panel.check.ts` for
`src/panel.tsx`); check renders the panel once per scenario and reports each under its name:

```ts
import { defineCheck } from 'orca/testing'

export default defineCheck({
  empty: {},
  'two agents': {
    results: {
      'agents.list': {
        agents: [
          {
            terminalId: 't1',
            title: 'Claude',
            agent: 'claude',
            state: 'working',
            stateStartedAt: 0
          },
          { terminalId: 't2', title: 'Codex', agent: 'codex', state: 'blocked', stateStartedAt: 0 }
        ]
      }
    },
    settings: { notifyOnBlocked: true },
    events: [
      {
        event: 'agent.status.changed',
        payload: { workspaceId: null, paneKey: 'p', terminalId: 't2', state: 'done', receivedAt: 0 }
      }
    ]
  }
})
```

A scenario takes everything `mockHost()` does (`results`, `requests`, `storage`, `settings`,
`secrets`, `capabilities`), plus `persisted` and `theme` as `mount()` takes them and `events`,
delivered in order after the first draw. `requests` stubs a request; any other name goes to the
worker. The file is a plugin source like any other (it may import `orca/testing`) and is never
loaded by Orca itself.

## Catalog

Props are semantic: tones, sizes and gaps, never class names, styles or colours. Colour has one
vocabulary, `tone`: `neutral` `accent` `success` `warning` `danger`.

| Component    | Props                                                                                                                                                                                    | Children                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `Stack`      | `gap` (`none` `xs` `sm` `md` `lg`), `align` (`start` `center` `end` `stretch`); unset, fields fill the width and buttons keep theirs                                                     | any                                               |
| `Row`        | `gap`, `align`, `justify` (`start` `center` `end` `between`), `wrap`                                                                                                                     | any                                               |
| `Text`       | `tone`, `muted`, `size` (`xs` `sm` `md`), `weight` (`regular` `medium` `semibold`), `truncate`                                                                                           | text, `Text` `Link` `Code` `Badge` `RelativeTime` |
| `Heading`    | `level` (1–3, below the panel title)                                                                                                                                                     | as `Text`                                         |
| `Button`     | `variant` (`solid` `outline` `ghost`), `tone`, `size`, `icon`, `disabled`, `onPress()`                                                                                                   | text                                              |
| `IconButton` | `icon` and `label` (required; the label is its name and tooltip), `variant`, `tone`, `size`, `disabled`, `onPress()`                                                                     | none                                              |
| `Badge`      | `tone`                                                                                                                                                                                   | text                                              |
| `Card`       | `title`, `description`                                                                                                                                                                   | any                                               |
| `List`       | `label`                                                                                                                                                                                  | `ListItem` only                                   |
| `ListItem`   | `title`, `description`, `icon`, `current`, `disabled`, `onPress()`                                                                                                                       | any; no controls with `onPress`                   |
| `Input`      | `label` (required), `labelHidden`, `value`, `defaultValue`, `placeholder`, `type` (`text` `search` `password`), `maxLength`, `invalid`, `disabled`, `onChange(value)`, `onSubmit(value)` | none                                              |
| `Switch`     | `label` (required), `checked`, `defaultChecked`, `disabled`, `onChange(checked)`                                                                                                         | none                                              |
| `Select`     | `label` (required), `labelHidden`, `value`, `defaultValue`, `placeholder`, `options` (`{ value, label, disabled? }[]`), `disabled`, `onChange(value)`                                    | none                                              |
| `Separator`  | `orientation` (`horizontal` `vertical`)                                                                                                                                                  | none                                              |
| `Progress`   | `label` (required), `labelHidden`, `value` (0–100)                                                                                                                                       | none                                              |
| `Spinner`    | `label` (required), `labelHidden`                                                                                                                                                        | none                                              |
| `EmptyState` | `title` (required), `description`, `icon`                                                                                                                                                | actions                                           |
| `Link`       | `href` (`https:`, `http:`, `mailto:`; opened in the OS browser), `onPress()`                                                                                                             | text                                              |
| `Code`       | `block`                                                                                                                                                                                  | text                                              |

`Button` and `IconButton` also take `tooltip` (since 1.4.247). A tooltip only names a control: an
`IconButton`'s defaults to its `label`; on a `Button`, use it for a short hint its text leaves out.

### Added in Orca 1.4.247 (`ui.catalog` 2)

Check `ui.has('Table')` (or `ui.catalog >= 2`) when your `engines.orca` minimum is older; see
forward compatibility below. The same release ships catalog 3, which adds `RelativeTime` and relative
Table cells (`ui.has('RelativeTime')`).

| Component      | Props                                                                                                                                                                                                                                                                                                                                                | Children   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `Textarea`     | as `Input` without `type`, plus `rows` (2–20); `onSubmit(value)` fires on Cmd+Enter (Ctrl+Enter off macOS)                                                                                                                                                                                                                                           | none       |
| `Checkbox`     | `label` (required), `description`, `checked`, `defaultChecked`, `disabled`, `onChange(checked)`                                                                                                                                                                                                                                                      | none       |
| `RadioGroup`   | `label` (required), `labelHidden`, `value`, `defaultValue`, `options` (`{ value, label, description?, disabled? }[]`), `orientation` (`vertical` `horizontal`), `disabled`, `onChange(value)`                                                                                                                                                        | none       |
| `Slider`       | `label` (required), `labelHidden`, `value`, `defaultValue`, `min` (0), `max` (100), `step` (1), `showValue`, `disabled`, `onChange(value)`                                                                                                                                                                                                           | none       |
| `Field`        | `label` (required), `description`, `error` (shown in the danger tone and announced), `required`                                                                                                                                                                                                                                                      | any        |
| `Tabs`         | `label` (required, the tab list's name), `value`, `defaultValue`, `onChange(value)`; only the selected tab's children are drawn                                                                                                                                                                                                                      | `Tab` only |
| `Tab`          | `value` and `label` (required), `icon`, `disabled`                                                                                                                                                                                                                                                                                                   | any        |
| `Collapsible`  | `title` (required), `description`, `open`, `defaultOpen`, `disabled`, `onChange(open)`; stack several for an accordion                                                                                                                                                                                                                               | any        |
| `Toolbar`      | `label` (required), `gap`; arrow keys, Home and End move between its controls                                                                                                                                                                                                                                                                        | any        |
| `Grid`         | `columns` (1–6, default 2) or `minItemWidth` (`xs` `sm` `md` `lg`: as many columns as fit), `gap`                                                                                                                                                                                                                                                    | any        |
| `Table`        | `label`, `columns` (`{ key, label, align?, width?, minWidth?, hideBelow?, sortable? }[]`) and `rows` (`{ key, cells, disabled? }[]`) required; `sort`, `selectionMode` (`none` `single` `multiple`), `selected`, `defaultSelected`, `hasMore`, `loading`, `emptyText`, `maxHeight`, `onSortChange`, `onSelectionChange`, `onRowAction`, `onLoadMore` | none       |
| `Tree`         | `label` and `items` (`{ key, label, description?, icon?, disabled?, hasChildren?, children? }[]`) required; `selected`, `defaultSelected`, `expanded`, `defaultExpanded`, `maxHeight`, `onSelect`, `onToggle`, `onAction`                                                                                                                            | none       |
| `Markdown`     | `content` (required, up to 64 KiB)                                                                                                                                                                                                                                                                                                                   | none       |
| `CodeView`     | `code` (required, up to 64 KiB), `language`, `label`, `lineNumbers`, `wrap`, `maxHeight`                                                                                                                                                                                                                                                             | none       |
| `Image`        | `src` (required: an image file in the plugin), `alt` (required; `''` for decoration), `size` (`xs` `sm` `md` `lg` `full`), `fit` (`contain` `cover`), `rounded`                                                                                                                                                                                      | none       |
| `KeyValue`     | `items` (`{ label, value, tone?, code? }[]`, required), `label`                                                                                                                                                                                                                                                                                      | none       |
| `Callout`      | `tone`, `title`, `icon`                                                                                                                                                                                                                                                                                                                              | any        |
| `Skeleton`     | `shape` (`text` `block` `circle`), `lines` (1–10, for `text`), `label` (its screen-reader name; default "Loading")                                                                                                                                                                                                                                   | none       |
| `RelativeTime` | `at` (required: ms since the epoch), `format` (`short` "5m ago", `long` "5 minutes ago", `duration` "5m"), `tone`, `muted`; Orca re-renders it as time passes, so the plugin never polls. Catalog 3; may sit inside `Text`                                                                                                                           | none       |

`maxHeight` (`sm` `md` `lg` `none`) gives long content its own scroll area: a `Table` and a `CodeView`
default to `md`, a `Tree` to `none`.

**Tables** draw only the rows in view, so thousands of rows stay cheap; rows scroll inside the table.
Sorting is yours: `onSortChange({ column, direction })` reports a header click, and Orca draws `rows` in
the order you give. A click selects (Cmd/Ctrl-click and Shift-click extend a `multiple` selection, as
do Space and Shift+arrows), `onSelectionChange({ keys })` reports it, and Enter or a double click calls
`onRowAction({ key })`. Paging is pull-based: with `hasMore`, scrolling within ten rows of the end
calls `onLoadMore()` once per length of `rows`; append the next page and Orca asks again when the
person nears the new end. Cells are strings, numbers, booleans (a check mark), `null`, or a relative
time Orca keeps current: `{ type: 'relative', at, format? }` (see `RelativeTime`).

In a narrow sidebar, give the main `auto` column a floor with `minWidth` (`xs` 4rem, `sm` 6rem, `md`
9rem) and let secondary columns drop out with `hideBelow: 'sm'` (under 360px) or `'md'` (under
480px); at least one column always stays. A cell or header cut short shows its full text on hover.

```tsx
const page = atom<Row[]>([])
const sort = atom<TableSort>({ column: 'name', direction: 'asc' })

<Table
  label="Files"
  columns={[{ key: 'name', label: 'Name', sortable: true }, { key: 'size', label: 'Size', align: 'end' }]}
  rows={read(page).map((file) => ({ key: file.path, cells: { name: file.name, size: file.size } }))}
  sort={read(sort)}
  selectionMode="multiple"
  hasMore={read(page).length < total}
  onSortChange={(next) => set(sort, next)}
  onLoadMore={() => loadNextPage()}
  onRowAction={({ key }) => open(key)}
/>
```

**Trees** take their items as data. Up and Down move, Right expands (or moves to the first child), Left
collapses (or moves to the parent), Home and End jump, Space selects and Enter calls `onAction({ key })`.
Orca keeps which items are open (seeded by `defaultExpanded`) and reports each change as
`onToggle({ key, expanded })`; that record ends when the Tree unmounts (a tab switch), so to keep it,
hold the open keys yourself and pass them as `expanded`. For lazy children, give an item `hasChildren` and no `children`: when it is
expanded Orca shows a loading row until a render brings its `children`. Item keys are unique across the
whole tree.

**Markdown** is GitHub-flavoured and runs through the same sanitizer as Orca's own Markdown. Links to
`https:`, `http:` and `mailto:` open in the OS browser like a `Link` with an `href` (the block must have
been stationary for 500 ms; see User gestures); any other link is text. Images show only when their
source is an image file in the plugin; anything else shows its alt text, so nothing is loaded from the
network.

**Images** come from the plugin's own folder (`assets/logo.png`): a static PNG, JPEG or WebP up to 8 MiB
and 4096 pixels a side, read by Orca with the same containment checks as the plugin's other files and the
same header check as a manifest's images. A URL, an absolute path or `..` is refused; an image that
cannot be shown draws a neutral placeholder.

**CodeView** colours code with Orca's own highlighter, including languages a syntax plugin adds, when
`language` names one; an unknown language stays plain.

**Toasts** are a host call, not a component: `host.call('notifications.show', { title, body })` shows a
desktop notification and resolves `{ delivered }`. Use a `Callout` for anything the person has to read
or act on.

`labelHidden` keeps the label as the control's accessible name without showing it.

**Icons** are the same names a manifest panel's `icon` takes, for example `add` `delete` `edit`
`refresh` `search` `settings` `check` `close` `info` `warning` `error` `open-external` `copy` `download`
`play` `stop` `more` `filter` `branch` `file` `folder` `terminal` `agent` `link` `rocket` `database`; see
`IconName` in the typings. Any other name shows a neutral fallback glyph.

**Forward compatibility:** an unknown prop or enum value is dropped (Orca logs a warning once), and an
unknown component, or one missing a required prop, is drawn as a neutral placeholder, so a panel built for a
newer Orca still shows the rest of its UI. Only structural problems (a `ListItem` outside a `List`, a
`Stack` inside `Text`, duplicate keys, controls inside a pressable `ListItem`) and the limits below refuse a
render.

Import only the components your minimum supported Orca exports. `orca` is a real ES module, so a named
import it lacks (`import { Carousel } from 'orca'` on an older Orca) is a link error: the whole panel
module fails to load, rather than getting `undefined`. For a component newer than your minimum, check
`ui.has()` and create it by name with `h`; an Orca that does not know it draws the placeholder:

```tsx
import { h, ui, Text } from 'orca'

const gallery = ui.has('Carousel') ? (
  h('Carousel', { label: 'Shots' })
) : (
  <Text muted>Update Orca to see the gallery.</Text>
)
```

## Inputs

Orca owns what the person types, so a re-render never drops characters and Enter submits exactly what is on
screen. `onChange(value)` reports each edit; `onSubmit(value)` fires on Enter.

- `defaultValue` seeds an uncontrolled field.
- `value` controls it. Once your panel has handled the person's latest edit, the `value` you render is what
  the field shows, including a reset to the same value it had before (`''` after submit). A render that
  your panel made before handling their latest keystrokes does not touch their text.
- `value` without `onChange` makes the field read-only. `Switch` (`checked`/`defaultChecked`) and `Select`
  (`value`/`defaultValue`) work the same way, and so do (since 1.4.247) `Textarea`, `Checkbox`,
  `RadioGroup`, `Slider`, `Tabs` (`value`), `Collapsible` (`open`/`defaultOpen`), a `Table`'s selection
  (`selected`/`defaultSelected` with `onSelectionChange`) and a `Tree`'s (`selected` with `onSelect`).

Handlers receive plain JSON: a string, number or boolean for most controls, and one small object where
there is more to say (`{ keys }`, `{ key }`, `{ key, expanded }`, `{ column, direction }`).

A handler that throws (or rejects) is reported in a banner attributed to your plugin; the panel keeps its
last good render.

## Limits

A render is refused, and the last good one kept, beyond 5000 nodes, depth 64, about 512 KiB of data,
16 KiB per text, 1 KiB per label prop, 32 props per node or 500 `Select` options. A component whose data
is over its own cap is drawn as a placeholder instead (with a warning): 50 `RadioGroup` options, 32
`Table` columns, 5000 rows, 2000 `Tree` items nested at most 16 deep, 200 `KeyValue` items, and 64 KiB
of `Markdown` or `CodeView` text. Row, column and item keys must be unique.

## User gestures

`host.call('shell.openExternal' | 'files.saveAs')` needs a user gesture, and only a press on Orca's own
controls counts (the hidden module never has one of its own). A press on a `Button`, `IconButton`,
`ListItem` or `Link` grants one call within 1 s, but only when that control has been stationary for 500 ms:
the same place in the tree, the same label and target, and the same position on screen. Anything that
moves it (including a sibling growing above it) restarts the wait, so a panel cannot slide a control under
the pointer just before a click. Scrolling the panel does not count as a move.

Presses on the 1.4.247 controls (tabs, checkboxes, table rows, tree items) never grant a gesture: put
the call behind a `Button` or `IconButton`. A link in `Markdown` opens only once its block has been
stationary for 500 ms, and grants nothing to the panel.

A `Link` follows the same rule before anything happens: a press on an unsettled `Link` neither opens its
`href` nor runs its `onPress`. When a `Link` has both, the `href` open uses the press, and `onPress` runs
without granting a second gesture.

## Isolation

The module runs in a hidden, sandboxed guest of the plugin's own partition, with the same isolation as frame
panels: no network (requests outside the plugin's own files are cancelled), no Node, no popups, no DOM
the person sees. It reaches Orca only through `host.call` (which `plugin`, `storage`, `settings` and
`secrets` use), `on`, and the UI it renders. Components panels need the desktop app: browser clients
(`orca serve` in a web browser) show that instead of the panel.
