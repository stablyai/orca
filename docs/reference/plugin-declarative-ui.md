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
  `persist: 'memory'` (default), `'plugin'` (every run of the plugin) or `'workspace'` (per Orca
  workspace; switching workspaces swaps the values). Persisted values must be plain JSON, load before the
  first render, are saved shortly after they change, and live in the plugin's own data folder; no
  capability is needed. When the stored shape changes, bump `version`; `migrate(stored, fromVersion)` turns
  an older value into the new shape, and without it the atom starts from `initial`.
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

## No build step

Orca transpiles `.tsx`, `.ts`, `.jsx` and `.mts` files when the panel loads, so a plugin ships its
source and no `dist/` folder: edit, save, and the panel reloads.

- Types are stripped and JSX compiles for `orca` (automatic runtime). Lines are kept, so an error's
  `file:line` in `orca plugin logs` is the line in your source; an inline source map covers columns
  in DevTools (`orca plugin dev inspect`).
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

## Catalog

Props are semantic: tones, sizes and gaps, never class names, styles or colours. Colour has one
vocabulary, `tone`: `neutral` `accent` `success` `warning` `danger`.

| Component    | Props                                                                                                                                                                                    | Children                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `Stack`      | `gap` (`none` `xs` `sm` `md` `lg`), `align` (`start` `center` `end` `stretch`)                                                                                                           | any                                |
| `Row`        | `gap`, `align`, `justify` (`start` `center` `end` `between`), `wrap`                                                                                                                     | any                                |
| `Text`       | `tone`, `muted`, `size` (`xs` `sm` `md`), `weight` (`regular` `medium` `semibold`), `truncate`                                                                                           | text, `Text` `Link` `Code` `Badge` |
| `Heading`    | `level` (1–3, below the panel title)                                                                                                                                                     | as `Text`                          |
| `Button`     | `variant` (`solid` `outline` `ghost`), `tone`, `size`, `icon`, `disabled`, `onPress()`                                                                                                   | text                               |
| `IconButton` | `icon` and `label` (required; the label is its name and tooltip), `variant`, `tone`, `size`, `disabled`, `onPress()`                                                                     | none                               |
| `Badge`      | `tone`                                                                                                                                                                                   | text                               |
| `Card`       | `title`, `description`                                                                                                                                                                   | any                                |
| `List`       | `label`                                                                                                                                                                                  | `ListItem` only                    |
| `ListItem`   | `title`, `description`, `icon`, `current`, `disabled`, `onPress()`                                                                                                                       | any; no controls with `onPress`    |
| `Input`      | `label` (required), `labelHidden`, `value`, `defaultValue`, `placeholder`, `type` (`text` `search` `password`), `maxLength`, `invalid`, `disabled`, `onChange(value)`, `onSubmit(value)` | none                               |
| `Switch`     | `label` (required), `checked`, `defaultChecked`, `disabled`, `onChange(checked)`                                                                                                         | none                               |
| `Select`     | `label` (required), `labelHidden`, `value`, `defaultValue`, `placeholder`, `options` (`{ value, label, disabled? }[]`), `disabled`, `onChange(value)`                                    | none                               |
| `Separator`  | `orientation` (`horizontal` `vertical`)                                                                                                                                                  | none                               |
| `Progress`   | `label` (required), `labelHidden`, `value` (0–100)                                                                                                                                       | none                               |
| `Spinner`    | `label` (required), `labelHidden`                                                                                                                                                        | none                               |
| `EmptyState` | `title` (required), `description`, `icon`                                                                                                                                                | actions                            |
| `Link`       | `href` (`https:`, `http:`, `mailto:`; opened in the OS browser), `onPress()`                                                                                                             | text                               |
| `Code`       | `block`                                                                                                                                                                                  | text                               |

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
  (`value`/`defaultValue`) work the same way.

A handler that throws (or rejects) is reported in a banner attributed to your plugin; the panel keeps its
last good render.

## Limits

A render is refused, and the last good one kept, beyond 5000 nodes, depth 64, about 512 KiB of data,
16 KiB per text, 1 KiB per label prop, 32 props per node or 500 `Select` options.

## User gestures

`host.call('shell.openExternal' | 'files.saveAs')` needs a user gesture, and only a press on Orca's own
controls counts (the hidden module never has one of its own). A press on a `Button`, `IconButton`,
`ListItem` or `Link` grants one call within 1 s, but only when that control has been stationary for 500 ms:
the same place in the tree, the same label and target, and the same position on screen. Anything that
moves it (including a sibling growing above it) restarts the wait, so a panel cannot slide a control under
the pointer just before a click. Scrolling the panel does not count as a move.

A `Link` follows the same rule before anything happens: a press on an unsettled `Link` neither opens its
`href` nor runs its `onPress`. When a `Link` has both, the `href` open uses the press, and `onPress` runs
without granting a second gesture.

## Isolation

The module runs in a hidden, sandboxed guest of the plugin's own partition, with the same isolation as frame
panels: no network (requests outside the plugin's own files are cancelled; Electron 43 still resolves
`dns-prefetch` hostnames), no Node, no popups, no DOM the person sees. It reaches Orca only through
`host.call`, `on`, and the UI it renders. Components panels need the desktop app: browser clients
(`orca serve` in a web browser) show that instead of the panel.
