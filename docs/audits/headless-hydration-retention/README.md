# Late headless snapshot ownership

## Reproduced defect

The runtime can retire a PTY or replace its headless model while a renderer/provider snapshot or emulator seed write is pending. The old completion still updates maps keyed only by PTY ID. After exit cleanup, a successful renderer reply recreates CWD, recent-output and title state; even an empty or rejected reply recreates the hydration `done` entry. A replaced model can also lose its provider preference or pending hydration status to the old completion.

Provider snapshot validation has two related races. Its late generation check calls an allocating getter, recreating an entry that exit just deleted. Its cleanup can delete a newer capture's live-mode scanner Set after the old Set becomes empty. Provider tail parsing has the same allocating late check after an awaited parse/write.

These paths exist in `v1.4.198`. They explain a concrete main/runtime retention mechanism under PTY churn, but the frequency and retained size in #19831/#19768 remain unproven. The renderer request already has a 750 ms timeout (`src/main/ipc/pty/ipc/serialize-buffer.ts`); this fix addresses callbacks writing after their owner retires, not an indefinite renderer wait.

## Fix and ownership

The three model-seeding paths compare `headlessTerminals.get(ptyId)` with the captured state before starting work and after asynchronous boundaries. Completion bookkeeping runs only for that state. Provider capture/tail completion compares the existing generation without allocating, and capture cleanup removes the map entry only while it still owns the same Set.

Admission generation allocation and normal queued live writes keep their existing behavior. Disposal still drains live writes queued before retirement. Current hydration, query replay suppression, CWD/kitty metadata and replacement capture mode tracking remain covered. These are local runtime ownership checks for both local and SSH-backed terminals; they add no process-death inference, remote cancellation or wire change. They do not depend on git worktrees.

## Reproduce

Run from the repository root with installed dependencies:

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/headless-hydration-retention/reproduce.mjs
```

The script runs the actual `OrcaRuntimeService` regression fixtures twice. For the before case, it reverses only the included four-file `fix.patch` in a temporary Vite transform. It neither rewrites source files nor needs an unpublished commit. The after case uses the checked-out source. Source hashes and individual failing cases are recorded in `results.json`.

- Before: **16 failed, 6 passed**.
- After: **22 passed**.

The tests control pending promises to cover retirement before callback admission, during renderer/provider replies, during seed writes and during kitty metadata application. They cover success, null, rejection, same-ID replacement, current-state success, generation preservation and live-mode scanner ownership. Provider-tail checks exercise both normal and visible-screen-only parsing.

Additional validation:

```sh
ORCA_BACKGROUND_LAUNCH=1 node node_modules/typescript/bin/tsc --noEmit -p config/tsconfig.node.json
ORCA_BACKGROUND_LAUNCH=1 node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/main/runtime/orca-runtime.test.ts src/main/runtime/terminal-query-responder.test.ts src/main/runtime/headless-hydration-ownership.test.ts src/main/runtime/headless-seed-ownership.test.ts --testNamePattern 'headless|hydrat|WSL|provider cwd|live WSL cwd|query|seed|retire|replacement|capture|renderer'
```

Node typecheck passed. The selected existing runtime/query checks plus the new cases passed **306 tests**, with 1087 unrelated cases skipped by the name filter. All runs were headless and used `ORCA_BACKGROUND_LAUNCH=1`.
