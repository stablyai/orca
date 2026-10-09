# Orca process host

This Node package owns subprocess spawning, forked children, bounded output, cancellation, Windows argument handling, and process-tree termination. Desktop, the headless server, CLI, SSH relay, and daemon use the same implementation. It has no runtime npm dependencies, Electron imports, or native addons.

Use `@orca/process-host` for `runProcess`, `runProcessSync`, `spawnProcess`, and their types. The explicit subpath exports expose focused capabilities such as forking, termination, Windows arguments, and the growable byte buffer. Application code must not import package source or private output files.

The application supplies policy through `process-tree-kill-gate` and diagnostics through `spawn-observer`. Register these before starting managed children. Each process must load one package instance so registration and execution share state. The production exports use one CommonJS output for both import and require callers. The `orca-source` condition supports tests, dependency analysis, and Node tooling that runs TypeScript through `tsx`. Source tooling runs in a separate process and must use that condition for every package import; mixing source and compiled output would split the registration state.

From the repository root:

```sh
pnpm --filter @orca/process-host build
pnpm --filter @orca/process-host typecheck
ORCA_BACKGROUND_LAUNCH=1 pnpm --filter @orca/process-host test
```

The package tests cover execution, output bounds, cancellation, termination, and Windows command construction. Windows shim integration stays under `src/shared/__tests__/process-host` because those tests use the host's filesystem cleanup policy. Root CI runs both sets; Windows integration still requires a Windows runner. Package artifact tests verify public exports and shared registration state from staged output.
