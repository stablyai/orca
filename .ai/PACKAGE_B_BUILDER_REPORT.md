# PACKAGE B — BUILDER REPORT

Task `task_0e152c8392d0` · Dispatch `ctx_6c7f2291bef8`
Branch `jb-workflow-control-plane-b`
Base `026389a3bc03da03ca2d65295e805493712b0774`
Final commit `9dbc4f6af4bf3892624f2fd187bcd3f5d37c94b4`
Tracked worktree state: **clean** (only untracked `.ai/` — the coordinator handoff docs and this report — and gitignored `node_modules/`).

CORRECTION 1 (`msg_40d7fe5510a7`) was consumed mid-build and is implemented in this same Task/Dispatch.

---

## 1. What was built

New substrate: `src/main/runtime/orchestration/control-plane/` (18 modules + 11 test files).
Wirings: worker-start admission, `worker_done` completion gate, dispatch preamble, two typed
worker CLI verbs, one bounded recovery query.

### Durable locations (named as the receipt requires)

| Thing | Location |
| --- | --- |
| Route registry (rows) | table `control_plane_routes`, accessor `control-plane/route-registry-store.ts` |
| Route certification evidence | table `control_plane_route_evidence`, contract `control-plane/route-certification-evidence.ts` |
| SCL model-performance ledger | table `control_plane_model_performance`, accessor `control-plane/model-performance-ledger.ts` |
| Outcome identity + relations | tables `control_plane_outcomes`, `control_plane_outcome_relations` |
| Liveness markers | table `control_plane_dispatch_liveness` |
| Gate receipts | table `control_plane_gate_receipts` |
| Validation leases | table `control_plane_validation_leases` |
| Schema definition | `control-plane/control-plane-tables-sql.ts`, created from `db/schema/create-tables.ts` |

---

## 2. Criterion → implementation → wiring

| Criterion | Implementation | Wired at |
| --- | --- | --- |
| B1 registry/admission | `role-route-registry.ts`, `route-registry-types.ts`, `route-certification-evidence.ts`, `route-registry-discovery.ts` | `orchestration-worker-route-admission.ts` → `orchestration.workerStart` (local **and** federated) |
| B2 outcome identity | `outcome-identity.ts` | consumed by the completion gate, worker-start admission fence, preamble binding, state query |
| B3 wake set | `coordinator-wake-events.ts` | consumed by `outcome-state-recovery`; documented in the skill guide (`--types worker_done,escalation,question`) |
| B4 liveness | `dispatch-liveness.ts` + marker table | heartbeat requirement **removed** from `preamble.ts`; marker read by `orchestration.state` |
| B5 worker protocol | `worker-protocol-context.ts`, `preamble.ts` (`buildDispatchPreamble`, `buildRetainedDispatchDelta`) | `orca orchestration report` / `escalate` (`worker-operation-handlers.ts`) |
| B6 completion receipt | `completion-receipt.ts`, `completion-gate-enforcement.ts`, `completion-evidence.ts` | `lifecycle-reconciliation.ts` before `settleWorkerReport` |
| B7 reviewer advance | `reviewer-advance.ts` | substrate only (see §5) |
| B8 gate receipts | `gate-receipt-validity.ts` | substrate only (see §5) |
| B9 validation lease | `validation-lease.ts` | substrate only (see §5) |
| B10 recovery | `outcome-state-recovery.ts` | RPC `orchestration.state` + CLI `orca orchestration state` |
| C1 ledger | `model-performance-ledger.ts` | substrate only (see §5) |

---

## 3. Discovered installed truth (CORRECTION 1)

Read from the authoritative catalogs at this SHA, asserted in
`route-registry-discovery.test.ts`. **None of these is a certification.**

- `grok` launcher + hook target; catalog has exact `grok-4.6` → identity proof `exact`.
- `codex` launcher + hook target; catalog has exact `gpt-5.6-sol` (Sol) → `exact`.
- `claude` launcher + hook target; catalog exposes family aliases `opus`, `fable`, `sonnet`, `haiku`
  → identity proof `alias`. **A generic `opus` alias cannot certify Opus 5.**
- `gemini` launcher + hook target; catalog has `gemini-3-pro-preview`, `gemini-3-flash-preview`,
  `gemini-2.5-*`. **`gemini-3.7-flash` and `gemini-flash-latest` are absent → `UNKNOWN`**, and the
  drift gate rejects them as `model_absent_from_catalog`.
- `opencode` (GLM harness) launches but is **not** a managed agent-hook target → the drift gate
  raises `launcher_supported_hook_rejected`, and admission refuses it as `launcher_hook_drift`.
  It also has no session-option catalog, so launch-time model pinning is unsupported.
- `qwen-code` is launcher-known and unconditionally excluded from Orca worker routing.

---

## 4. Proof

Runner: Node 24.20.0 (repo `engines.node: 24`), pnpm 10.24.0.

- `pnpm run tc` (node + cli + web): **0 errors**.
- `pnpm test src/main/runtime/orchestration/ src/main/runtime/rpc/ src/cli/`:
  **360 files, 3197 passed, 1 skipped, 0 failed**.
- New control-plane + CLI evidence tests: **137 passed** across 14 files.
- `oxlint src/main src/cli src/shared`: clean (no suppressions added; two files were split
  rather than bumping `max-lines`).
- `pnpm run check:code-quality:changed`: 0 new findings across 54 changed files.
- `pnpm run check:max-lines-ratchet`: OK, no new bypasses.
- `pnpm run check:reliability-gates`: passed (99 gates).
- `pnpm run verify:bundled-skill-guides` / `verify:skill-bundle-manifest`: pass
  (`src/cli/bundled-skill-guides.ts` regenerated by the generator, as its contract requires).
- `oxfmt --check` on every changed file: clean.

### Pre-existing failure, not caused by this work

`src/shared/runtime-client-export-parity.test.ts` fails on the **base commit itself**
(`026389a3bc03`), verified by checking the base out into a throwaway worktree and running that
single test. It concerns `TERMINAL_PTY_DEGRADATION_CAPABILITY` / `TERMINAL_UNAVAILABLE_ERROR_CODE`
exports. This branch changes nothing under `src/shared/` (`git diff --name-only <base> -- src/shared/`
is empty).

### Negative controls (each fails if its guard is removed)

- `route_untested` for a route with no evidence; `route_stale` for evidence bound to a different SHA; `route_failed` for FAIL evidence — all excluded from `listAdmissibleRoutes`.
- Fable rejected for a builder role it has no certified evidence for; still admitted as reviewer.
- `qwen-code` rejected regardless of evidence.
- requested/effective mismatch and null effective identity both rejected.
- alias identity proof rejected as `identity_proof_insufficient`.
- quota `UNKNOWN` unschedulable without `allowUnknownQuota`.
- launcher-supported + hook-rejected route rejected, and the drift gate reports it.
- registry permutation (3 orders) yields an identical eligible set.
- `selectRoute` with no candidate order refuses instead of picking.
- unrelated-Run reuse rejected (`run_bound_to_other_outcome`); replayed identical admission is a no-op; changed fingerprint rejected.
- undecided semantic-overlap / resource-collision refuses the whole intake.
- `status`, `heartbeat`, `dispatch`, `handoff`, `merge_ready`, `decision_gate` produce no wake; empty wait produces no wake.
- stall and crash each wake exactly once; a repeat sweep in the same state does not re-wake; a crashed marker cannot be resurrected.
- preamble contains no `heartbeat`, no `--subject "alive"`, no `--phase`, and no `N minutes` cadence.
- stale-SHA PASS receipt, FAIL receipt, missing receipt, dirty worktree, wrong task/dispatch/run/outcome all rejected — on the **real** `reconcileLifecycleMessage` path, with the Task left `dispatched`.
- a legacy (outcome-unbound) Run still completes exactly as before.
- retained delta is < 1/3 the fresh bootstrap and repeats none of its rules.
- review blocked until the completion is validated; blocked when no certified reviewer route exists; never selects the builder's own route.
- FIX_FIRST targets the same retained builder and is blocked when the session or its route lapses.
- gate receipt reuse only when SHA, input hashes, policy version and command identity all match; high-risk policy always reruns.
- active lease blocks mutation and returns exactly two remedies; no lease allows it; expired lease is reclaimed; duplicate release is a no-op.
- ledger rejects any provenance outside the two evidence-backed values, and the row has no free-text column.
- `orchestration state` returns a fixed 7-key record and one event from a 50-message window.

---

## 5. Explicitly NOT live-certified / not wired

**No route is certified.** Every registry row in a real database is `UNTESTED` until a live
certification run writes evidence. The tests exercise the state machine with synthetic evidence;
they are not, and must not be read as, a live PASS for Opus 5, GLM-5.3, Gemini 3.7 Flash,
Grok 4.6, Fable or Sol. Real fresh/retained role certification remains a post-build runtime gate.

Substrate implemented and unit-proven, but with **no production call site yet** (each needs a
runtime owner the Control Room has not yet named):

- B7 `planNextAfterBuild` — nothing auto-advances a validated completion to a reviewer Dispatch yet.
- B8 `planGateSet` / `recordGateReceipt` — no gate runner records receipts yet.
- B9 `acquireValidationLease` / `assertMutationAllowed` — no test/preflight runner takes the lease yet.
- C1 `ModelPerformanceLedger` — nothing writes an entry yet.
- B4 `sweepDispatchLiveness` — the classifier and marker exist and the state query reads them, but no
  periodic runtime sweep feeds it evidence. The evidence source lives in `orca-runtime.ts`, which is
  outside the allowed scope; wiring it is the natural next Dispatch.
- B3 non-polling subscription — `check --wait --types` already provides the runtime-owned wait and
  the canonical wake set is now typed and documented, but no new subscription RPC was added
  (`check`/Delivery behaviour is deliberately unchanged for compatibility).

---

## 6. Compatibility evidence

- **Schema**: additive only. All nine new tables use `CREATE TABLE IF NOT EXISTS` from the same
  constructor path as the legacy tables; `user_version` is untouched and no migration was added.
  No column, table, index or trigger was altered or dropped.
- **Historical rows**: `outcome-identity.test.ts` asserts a Task created before the control plane
  is byte-identical after the store opens the same database, and reports `legacy_unbound`.
- **worker_done**: the completion gate applies **only** to Runs with an admitted outcome; a legacy
  Run completes exactly as before (regression test present). New writes on an admitted Run fail closed.
- **worker-start**: route admission applies only to outcome-admitted Runs; the `qwen-code`
  exclusion is unconditional. All 3197 existing orchestration/RPC/CLI tests still pass.
- **Wire**: `report`/`escalate` are CLI adapters over the unchanged `orchestration.send` method, so
  they work against an older runtime. `orchestration.state` is a new method; an older runtime
  returns method-not-found for it. `orchestration send --type worker_done` and `--type heartbeat`
  remain fully supported for preambles already live in a pane.
- **Preamble**: the renderer strips on `=== TASK ===`, which is unchanged.

---

## 7. Builder-side adversarial review — findings found and fixed before commit

1. **Statement-cache thrash.** `ControlPlaneStore` re-ran `CREATE TABLE` DDL on every construction,
   and the SQLite adapter drops its whole prepared-statement cache on schema-changing exec — so every
   `worker_done` would have wiped it. Fixed: one ensure per database handle via a `WeakSet`.
2. **Lost lifecycle authority.** The new `report`/`escalate` invocations omitted `--from`, leaving
   them dependent on `ORCA_TERMINAL_HANDLE` surviving a restart, where the old preamble bound the
   worker handle explicitly. Fixed: `--from <workerHandle>` is bound in both the preamble and the
   protocol context.
3. **Federated bypass.** `orchestration.workerStart --on` returned early before route admission.
   Fixed: the gate now runs on the federated branch too.
4. **Outcome-only recovery returned no events.** `orchestration.state --outcome <id>` did not resolve
   the outcome's Run before reading the mailbox. Fixed.
5. **Required `runId` in the completion claim.** The worker was forced to restate a Run the runtime
   already knows, and an omitted one made the whole claim read as malformed. Fixed: `runId` is
   optional; when stated it is still checked for mismatch.

### Known limitations (accepted, not defects)

- `completion-evidence.ts` spawns `git` by bare name. On Windows the repo prefers absolute paths;
  a PATH miss here degrades to `unavailableReason` and a fail-closed gate, never a crash.
- `claimedSha` must equal the full observed HEAD exactly, so an abbreviated SHA is rejected. The CLI
  defaults it to the observed full HEAD, so the normal path is unaffected.
- The completion gate runs immediately before, not inside, the settle transaction. The outcome
  binding it reads is immutable once admitted, so there is no window to exploit.
