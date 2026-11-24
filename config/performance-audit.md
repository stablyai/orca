# Performance regression checks

`pnpm --silent audit:perf > performance-audit.json` scans production `src/` with
the existing app-store and buffer-concatenation rules. Warnings are advisory in this full inventory; tool/parser failures fail.
New findings from rules enabled in the changed-code configuration fail
`pnpm check:code-quality:changed`.

`app-store-performance/no-whole-hot-map-selector` catches selectors returning a whole
fleet-keyed map (host runtime status, agent status, pane and tab maps, Git status and the
other fields in `HOT_STORE_FIELDS`). Each of those maps gets a new reference whenever any one
entry changes, so the selector re-renders its owner on every other host's, pane's or worktree's
update. It is a warning in this inventory, and `pnpm check:whole-hot-map-selector-ratchet`
fails new sites per file and field against `config/whole-hot-map-selector-baseline.txt`, which
may only shrink. Select a stable derived answer inside the selector (see
`paired-runtime-parking-capabilities.ts`). A consumer that needs every entry adds
`// oxlint-disable-next-line app-store-performance/no-whole-hot-map-selector -- <why every entry is needed>`.
It resolves direct returns, `??`/`||` fallbacks, the right side of `&&`, branches, values
one level inside a `useShallow` object or array, module-scope named selectors and selector-local const
aliases/destructuring; it does not infer consumer lifetime or follow imported
helpers, so behavior-level render-isolation assertions remain the safeguard against
fanout through other paths.

Tests, generated files, `mobile/` and `cloud/` are outside this source audit.

The ast-grep rule `config/ast-grep/rules/no-repeated-collator.yml` (`pnpm lint:ast-grep`,
an error everywhere) detects optioned `localeCompare` and `Intl.Collator` construction
inside inline `sort`/`toSorted` callbacks. Construct one collator outside the
callback, preserving locale, options and tie-breakers. If the locale changes at
runtime, reconstruct at the next sort or key the cache by locale. Bare comparisons
and standalone equality checks are allowed. There is no autofix or interprocedural
analysis: named comparators, aliases, custom methods and deferred callbacks need
manual review. A finding identifies repeated setup, not proof of visible lag.

`pnpm test:perf:contracts` runs every `*.performance.test.{ts,tsx,mjs}` file, plus a few
older contracts listed by name in `vitest.performance.config.ts`: Codex rollout lifetimes and
incremental scans, pinned JSONL reading, the launch-menu host preferences, and the two lint-plugin
contracts. Only the `*.performance.test.*` files may count work; the older ones get no exception (see
[perf contracts](../docs/agents-md-refs/test-antipatterns.md#perf-contracts)). The selection is
count-only and runs in seconds: wall-clock budgets and long disk runs stay out of it. Missing
listed files fail configuration loading. Files run in parallel worker processes (counts are
per process), without retries, and inherit the full suite's setup and forced-GC support.

`.github/workflows/performance-contracts.yml` runs daily and manually on Linux,
macOS and Windows, and on every PR that changes a contract or this tooling. Ready PRs already run
every contract on Linux in the full unit suite; dependency selection applies only to drafts.
It uploads per-OS JSON test results, plus the source inventory once from Linux
because that scan is OS-independent. Its schedule starts after merge. The rendered typing/frame benchmark was retired ([historical guide](../docs/readme/terminal-perf.md)). Unit tests do not
measure SSH RTT, WSL scheduling or a packaged Electron renderer.

To extend coverage, select a production-path regression with an operation-count,
identity, queue-admission or retained-memory oracle. Confirm it fails with the
old behavior. Use controlled, counterbalanced benchmark samples for timings;
avoid new machine-dependent millisecond gates in the normal unit suite. A green
source scan and these contracts cannot establish that the whole app is fast.

Count ratchets (counts per file may only fall) cover classes the audit only warns about:
`pnpm check:main-sync-fs-ratchet` counts synchronous `node:fs` calls (every `*Sync` export) in production `src/main` and `src/shared`
(`config/main-sync-fs-baseline.txt`), and `pnpm check:recurring-timer-ratchet` counts `setInterval`
calls in production `src/main`, `src/renderer`, `src/shared` and `src/cli`
(`config/recurring-timer-baseline.txt`). `pnpm check:main-blocking-helper-ratchet` counts references to
functions that make a synchronous fs, child_process or SQLite call, or call such a function (`config/main-blocking-helper-baseline.txt`),
so a new caller of an existing sync helper in another file fails too. The main-blocking ratchets skip modules
imported only by worker or utility entries (`config/main-blocking-worker-entries.json`). All run in
`check:ratchets` on every non-draft PR that runs static analysis. A new use either
moves off the hot path (async fs or a stat-fingerprint cache; a push signal, a visibility-gated or
backing-off timer) or raises its file's count with reviewer sign-off.
