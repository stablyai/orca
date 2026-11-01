# Hello TSX

A components panel written in TSX with no build step and no `dist/` folder, plus the plugin's own
worker. Orca transpiles `src/*.tsx` and `src/*.ts` when the panel loads (types stripped, JSX
compiled for `orca`, relative imports such as `./todos` resolved to their files).

```sh
orca plugin dev load .   # also writes .orca/types, the typings tsconfig.json extends
npx tsc -p .             # optional type check
orca plugin test .       # runs src/panel.test.tsx in Node with orca/testing
orca plugin check .      # renders the panel once and reports errors with file:line
```

Import only `orca` and relative files: there is no bundler, so `import 'react'` fails with an
error naming the file and the import.

It shows one of each part of the API:

- **Components**: keyed atoms, `derived` values, `setup(ctx)` and `ui.has` feature detection.
- **Panel → worker**: Suggest calls `plugin.request('tasks.suggest')`, answered by
  `orca.panels.handle` in `worker/main.mjs`, which starts on the panel's first request.
- **Worker → panel**: the worker `orca.panels.post`s `tasks.allDone` when the last task is done;
  the panel hears it with `plugin.on`.
- **Shared storage**: the task list is `atom('todos', ..., { persist: 'storage' })`, so the
  worker reads the same value with `orca.storage.get('todos')` and hears each change.
- **Settings**: `contributes.settings` declares `celebrate` and `suggestions`; change them under
  the plugin in Orca's Settings and the worker reads them with `orca.settings.get`.
- **Events**: `on('agent.status.changed')` counts working agents (the `agent:read` capability).
- **One typed contract**: `src/protocol.ts` declares `PluginRequests` and `PluginPanelEvents` in
  `declare module 'orca'`, so both sides type-check against it.
