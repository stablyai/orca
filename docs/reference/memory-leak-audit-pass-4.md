# Memory Leak Audit Pass 4

Started: 2026-05-31 PDT

Objective: continue the memory leak audit on current `origin/main` after pass 3
and submit one PR per confirmed issue.

## Delta Inventory

- 2026-05-31: Rebases completed on current `origin/main`
  (`7d91c5c5d3`, `perf: coalesce startup history gc`).
- 2026-05-31: Counted 14 changed code files since pass 3
  (`41cbdb1d1d65f9c9538a2347684e1f4ddb3f06ec`).
- 2026-05-31: Re-ran heuristics for DOM listeners, timers, animation frames,
  observers, EventEmitter subscriptions, runtime subscriptions, child process
  streams, and module-scope `Map`/`Set` caches.
- 2026-05-31: Manually followed up delta hits in daemon sockets, macOS resolver
  health probing, workspace port scanning, onboarding timers, terminal history
  GC, browser webview listeners, terminal pane listeners, and diff comment view
  zones.

## Finding

- `src/main/network/macos-system-resolver-health.ts`: the macOS resolver probe
  resolved on timeout after killing `scutil`, but kept stdout/stderr data
  listeners and child `error`/`close` listeners attached until the process
  eventually closed. If `scutil` was slow or stuck after `SIGTERM`, those
  listeners retained the request closure after the daemon RPC had already
  settled. Fixed by using named listeners and detaching them in the shared
  settlement path for both timeout and normal child close. Risk: low.

## Validation

- `pnpm exec vitest run --config config/vitest.config.ts src/main/network/macos-system-resolver-health.test.ts src/main/daemon/daemon-server.test.ts`
- `pnpm exec oxlint src/main/network/macos-system-resolver-health.ts src/main/network/macos-system-resolver-health.test.ts src/main/daemon/daemon-server.ts src/main/daemon/daemon-server.test.ts docs/reference/memory-leak-audit-pass-4.md`
- `pnpm run typecheck:node`
- `git diff --check`

## Remaining Work

- Continue the current-state repository audit. This pass covered the post-pass-3
  delta and one confirmed leak; it does not prove the full repository is
  entirely leak-free.
