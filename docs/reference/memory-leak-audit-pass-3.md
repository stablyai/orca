# Memory Leak Audit Pass 3

Started: 2026-05-31 PDT

Objective: continue the repository-wide leak audit from pass 2 on current
`origin/main`, with special attention to code changed after
`a85e4e8d88` (`docs: record memory leak audit pass 2`).

## Delta Inventory

- 2026-05-31: Fast-forwarded the audit worktree to current `origin/main`.
- 2026-05-31: Counted 1431 changed code files since pass 2 (`*.ts`,
  `*.tsx`, `*.js`, `*.jsx`, `*.mjs`, `*.cjs`, `*.swift`).
- 2026-05-31: Re-ran delta heuristics for DOM/RN listeners, timers,
  animation frames, observers, EventEmitter subscriptions, runtime
  subscriptions, workers, WebSockets, abort controllers, streams, and
  module-scope `Map`/`Set` caches.
- 2026-05-31: Manually followed up high-risk delta hits in GitHub renderer
  state, PR diff caches, combined diff caches, mobile browser frame caches,
  main subprocess listeners, runtime file watchers, browser/webContents
  listeners, notification lifetimes, and renderer UI timers.

## Finding

- `src/renderer/src/store/slices/github.ts`: `prRequestGenerations` was a
  module-scoped map keyed by PR cache key. Each unique PR lookup inserted a
  generation entry, but completed requests only removed `inflightPRRequests`;
  the generation entry remained for the lifetime of the renderer. Fixed by
  deleting the generation key when the request that owns the current
  generation is also the active in-flight request. Overlapping forced refreshes
  still keep the stale-response guard because older requests cannot delete a
  newer generation. Risk: low.

## Validation

- `pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/store/slices/github.test.ts`
- `pnpm exec oxlint src/renderer/src/store/slices/github.ts src/renderer/src/store/slices/github.test.ts`
- `pnpm exec tsgo --noEmit -p config/tsconfig.tc.web.json`
- `git diff --check`

## Remaining Work

- Continue the pass-3 delta audit beyond the confirmed GitHub PR generation
  leak. Current evidence does not prove the full repository is leak-free.
