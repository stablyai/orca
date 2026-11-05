# Orca process host

This Node package owns subprocess spawning, forked children, bounded output, cancellation, Windows argument handling, and process-tree termination. Desktop, the headless server, CLI, SSH relay, and daemon use the same implementation. It has no runtime npm dependencies, Electron imports, or native addons.

Import `runProcess`, `runProcessSync`, and `spawnProcess` from `@orca/process-host`. Import their contracts and default limits from `@orca/process-host/process-spec`. Other explicit subpaths expose forking, termination, Windows arguments, and bounded output. Application code must use public exports.

`spawnProcess` guarantees three stream pipes when `stdio` is omitted, is `'pipe'`, or starts with `['pipe', 'pipe', 'pipe']`. Other specifications return a child with nullable streams. Use `PipedProcessSpec` and `PipedChildProcess` when a stream-owning interface requires pipes.

The application supplies policy through `process-tree-kill-gate` and diagnostics through `spawn-observer`. Register these before starting managed children. Each process must load one package instance so registration and execution share state. The production exports use one CommonJS output for both import and require callers. The `orca-source` condition supports tests, dependency analysis, and Node tooling that runs TypeScript through `tsx`. Source tooling runs in a separate process and must use that condition for every package import; mixing source and compiled output would split the registration state.

From the repository root:

```sh
pnpm build:packages
pnpm --filter @orca/process-host typecheck
ORCA_BACKGROUND_LAUNCH=1 pnpm --filter @orca/process-host test
```

Which copy a caller loads:

- Root app build, test, typecheck, and launch scripts build `dist` first. Editor types and root typechecks read its declarations.
- `pnpm dev` refreshes `dist` once at launch. Restart it after package edits, or run `pnpm dev --watch` to rebuild the package and restart the app after package or main-process source changes.
- Run `pnpm build:packages` after package edits before invoking config scripts or Vitest directly; their bootstrap code can read `dist`.
- Vitest and `tsx --conditions=orca-source` load `src` through the `orca-source` condition.
- Packaging ships `dist`; supported build scripts and CI rebuild it first. The packaging guard checks missing exports/modules and removed-source leftovers, but does not certify source freshness. Build the package before invoking electron-builder directly.

The build needs no prior `dist`: `tsx --conditions=orca-source` starts its compiler through source. It serializes builds with a lock, compiles into staging, adds new files before replacing existing files, then removes obsolete output. Failed compilation preserves prior output; unchanged files are not rewritten. Publication is atomic per file, so a concurrent reader can still observe mixed build versions. Detected lock loss stops subsequent writes and preserves the new owner's lock; already published files remain. `tsx` and `proper-lockfile` are build-only dependencies.

The package tests cover execution, output bounds, cancellation, termination, and Windows command construction. Windows shim integration stays under `src/shared/__tests__/process-host` because those tests use the host's filesystem cleanup policy. Root CI runs both sets, and root `pnpm typecheck` type-checks the package tests through `tsconfig.test.json`; Windows integration still requires a Windows runner. Package artifact tests verify public exports and shared registration state from staged output. The `engines` floor is Node 18 because the relay bundles this package for remote hosts. Its compiler uses Node 18 module semantics and Node 18 types to reject newer builtin APIs; CI's Node 18 job runs `config/scripts/smoke-process-host-node18.mjs` against the staged public output. Repository build and test tools use the root manifest's newer Node requirement.
