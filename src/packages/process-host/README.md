# Orca process host

This Node package owns subprocess spawning, forked children, bounded output, cancellation, Windows argument handling, and process-tree termination. Desktop, the headless server, CLI, SSH relay, and daemon use the same implementation. It has no runtime npm dependencies, Electron imports, or native addons.

Use `@orca/process-host` for `runProcess`, `runProcessSync`, `spawnProcess`, and their types. The explicit subpath exports expose focused capabilities such as forking, termination, Windows arguments, and the growable byte buffer. Application code must not import package source or private output files.

The application supplies policy through `process-tree-kill-gate` and diagnostics through `spawn-observer`. Register these before starting managed children. Each process must load one package instance so registration and execution share state. The production exports use one CommonJS output for both import and require callers. The `orca-source` condition supports tests, dependency analysis, and Node tooling that runs TypeScript through `tsx`. Source tooling runs in a separate process and must use that condition for every package import; mixing source and compiled output would split the registration state.

From the repository root:

```sh
pnpm build:packages
pnpm --filter @orca/process-host typecheck
ORCA_BACKGROUND_LAUNCH=1 pnpm --filter @orca/process-host test
```

`build` runs `scripts/build-dist.mjs` under `tsx --conditions=orca-source`, so it spawns the compiler through this package's own source and needs no prior `dist`. It holds a build lock across compile and publish, compiles with the package's own TypeScript into a private staging directory, then moves each changed file into `dist` with an atomic rename. Unchanged files are not rewritten, outputs of renamed or deleted sources are removed, and a failed compile leaves `dist` as it was. Every build still runs the full compile; a build with no source changes writes nothing to `dist`. Each file is replaced atomically, so a reader never sees a truncated file, but a publish is not an atomic multi-file transaction: a process loading `dist` while a build publishes can see some files from the old build and some from the new one. Parallel builds wait for the lock. When proper-lockfile's periodic heartbeat detects a compromised lock, the build stops before its next output write, including a Windows rename retry, and preserves the new owner's lock. Files already published stay in place. `tsx` and `proper-lockfile` are build-only devDependencies; the runtime output still has no dependencies.

Which copy a caller loads:

- The root scripts that run, bundle, type-check, or package the app (`dev`, `start`, `build:*`, `typecheck*`, `test`) build `dist` first. Root type-checks read types from `dist`.
- `pnpm dev` refreshes `dist` once at launch. Restart it after package edits, or run `pnpm dev --watch` to rebuild the package and restart the app on each main-process save.
- Run `pnpm build:packages` after package edits before invoking a config script directly (`node config/scripts/...`), running `vitest` without the root `test` script, or relying on editor types; those read `dist`.
- Vitest and `tsx --conditions=orca-source` load `src` through the `orca-source` condition.
- Packaging fails in `beforePack` when `dist` is missing a public export or a compiled module, or still holds output of a removed source.

The package tests cover execution, output bounds, cancellation, termination, and Windows command construction. Windows shim integration stays under `src/shared/__tests__/process-host` because those tests use the host's filesystem cleanup policy. Root CI runs both sets, and root `pnpm typecheck` type-checks the package tests through `tsconfig.test.json`; Windows integration still requires a Windows runner. Package artifact tests verify public exports and shared registration state from staged output.
