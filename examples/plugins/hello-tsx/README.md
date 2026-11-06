# Hello TSX

A components panel written in TSX with no build step and no `dist/` folder. Orca transpiles
`src/*.tsx` and `src/*.ts` when the panel loads (types stripped, JSX compiled for `orca`, relative
imports such as `./todos` resolved to their files).

```sh
orca plugin dev load .   # also writes .orca/types, the typings tsconfig.json extends
npx tsc -p .             # optional type check
orca plugin test .       # runs src/panel.test.tsx in Node with orca/testing
orca plugin check .      # renders the panel once and reports errors with file:line
```

Import only `orca` and relative files: there is no bundler, so `import 'react'` fails with an
error naming the file and the import.

It shows the components API: keyed atoms persisted per plugin (`src/todos.ts`), `derived`
values, `setup(ctx)` subscribing to the typed `on('theme')` event, and `ui.has` feature
detection.
