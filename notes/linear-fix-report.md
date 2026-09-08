# Session identity repair report

Base: `588240043e8` (newer than the triage base). Refreshed all 19 named Linear issues with full comments and attachments through `orca linear issue ... --full --json`; no Linear writes were made. Searched open PRs by mechanism and issue IDs, and inspected #19405 and merged #17909.

## Delivered

Three focused commits in one draft PR (URL recorded below):

- `e486911e2be`: sleeping resume checks live status, pending startup, and automatic claims across workspaces when provider identity, exact transcript path, execution host, and paired transport environment agree. Reuses the existing provider equality and route resolver. Folder owners are included; different account paths and hosts are isolated. Consecutive sweeps share the existing queued claim. This is renderer suppression, **not atomic host claiming**; legacy ID-only records retain existing behavior.
- `f93fb796898`: offline/error/conflicting direct-SSH syncs remain `unverifiable`, including after a prior hydration. Repeated sweeps preserve the record; successful hydration/retry permits one launch. No inventory failure proves process exit.
- `4465097095c`: runtime partition access and hydration reuse the ambiguity-aware repository host resolver. An empty runtime partition no longer adopts a foreign same-ID workspace; conflicting repo owners block reads/writes and are skipped during hydration. Ambiguity throws before legacy callers can default null to local. Foreign records are preserved, including folder state.

## Validation

All test/typecheck commands used `ORCA_BACKGROUND_LAUNCH=1`.

- Renderer regression suite: 7 files / 66 tests passed, including existing remote compatibility and replay suites. The subsequently extended cross-workspace file passed all 8 tests (one extra consecutive-sweep regression).
- Runtime partition suite: 2 files / 14 tests passed, including close/retirement integration tests that now preserve unproven foreign state.
- `pnpm tc:web` and `pnpm tc:node` passed; node rechecked after the final ambiguity fence.
- Changed-file quality gate passed with zero native, type-aware, or React Doctor findings across 8 source files; formatting/commit hooks and `git diff --check` passed.
- Existing SSH reattach discrimination tests: 2 files / 7 tests passed, supporting the STA-3375 source-seam disposition.
- No rendered Electron/real SSH/WSL/Windows validation, host restart, account migration, or multi-client process-ownership experiment was performed. No user session was cleaned up or machine configuration changed.

## Issue disposition

No issue is claimed fully resolved by this draft. The broad one-writer closure criteria remain open.

| Issue | Disposition and exact coverage |
|---|---|
| STA-3513 | Open: traced renderer `local-partition` versus runtime SSH host persistence; shared helper explicitly documents the divergence. Durable read-both migration is not implemented. Existing #12722 covers read-side adoption separately. |
| STA-6807 | Open: required `executionHostId` at all unified-tab normalization boundaries remains unimplemented. |
| STA-6535 | Partial: runtime controller no longer uses first/last repo row or foreign nonempty partitions. Ambiguous IDs fail closed; explicit per-operation host selection and renderer/runtime durable partition convergence remain. Merged #17909 supplied the shared resolver reused here. |
| STA-6297 | Partial: renderer cross-worktree claims covered when exact transcript and host scope are known. ID-only records, absent projections, multiple clients, and atomic execution-host claims remain. Open #19405 supports incumbent writer placement but explicitly does not close this ticket. |
| STA-3498 | Partial: failed SSH hydration no longer permits sweep resume. Stale record worktree ownership, all pane reattach paths, and atomic remote claiming remain. |
| STA-3500 | Partial: initial hydration guard already exists in base; this draft closes its offline/error/conflict escape. Full remote reconnect and all wake replay paths are not demonstrated. |
| STA-3375 | Already addressed at the cited source seam: existing restoreRequired discrimination and live-source regression tests distinguish it from expiry. This draft does not change reattach or establish all historical secondary triggers resolved. |
| STA-3499 | Open: AI Vault Resume entrypoint remains unchanged; #19405 is supporting runtime placement work, not closure. |
| STA-6719 | Partial support only: scoped sleeping sweep claims improve one activation branch. Paired OMP reselect and initial-terminal seeding symptom not reproduced or claimed fixed. |
| STA-6741 | Open: unattended same-worktree headless launch trigger remains unestablished; renderer cross-worktree coverage does not prove its fix. |
| STA-5907 | Open: Windows reboot/update duplication and title/PTy binding not reproduced. Existing #18223 covers default-tab ledger persistence separately. |
| STA-6240 | Open: rapid AI Vault resume clicks are not tested or serialized by this change. Consecutive sleeping sweeps are a different covered path. |
| STA-2856 | Open: existing session-tabs publisher runtime-ID fences are present, but stale CLI handle reconciliation across host restart is not changed or proven. |
| STA-3110 | Existing open PR #17798 owns authoritative null-PTY ghost pruning; not duplicated or modified here. |
| STA-2210 | Open: historical Windows/WSL ghost inventories and daemon memory retention are not addressed by these changes. |
| STA-6224 | Partial ownership split: viewer ghost work exists in #17798; server CLI close repair belongs to worker 2. No closure claim from this draft. |
| STA-6830 | Open: traced global event handling and visibility fences but did not establish a failing new-workspace snapshot path; no speculative subscription change. |
| STA-6721 | Open: independent sidebar row/status join and missing-tab projection remain unmodified. |
| STA-5904 | Existing open PR #17139 covers visible terminal identity; no incarnation-proof feature duplicated here. |

## Limits and follow-up

No new RPC fields, opcodes, or published snapshot shapes are introduced. Existing remote-compatibility tests cover the sleeping sweep, not a real mixed-version host/client matrix. Partition adoption by unique matching ID was intentional historical behavior; removing it can leave old relocated state inaccessible until a migration supplies host identity evidence, and that is deliberately safer than copying or retiring another host's state. SSH folder snapshot scope remains unchanged because the direct-SSH snapshot does not publish folder rows. A full execution-host account-scoped reservation and inventory-generation authority must be coordinated with #19405 and applied to all launch paths; these three safeguards do not substitute for it.
