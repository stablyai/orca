# PACKAGE B — CORRECTION 2 REPORT

Task `task_ca5b817beb0f` · Dispatch `ctx_e6be9cf60f9f`
Branch `jb-workflow-control-plane-b`
Base `026389a3bc03` → correction 1 `9dbc4f6af4bf3892624f2fd187bcd3f5d37c94b4` → **correction 2 `764d61f4cf282010ae7c748aa27baf8f672ab995`**
Tracked worktree state: **clean** (only untracked `.ai/` docs).
Diff vs the previous commit: 39 files, +4177 / −45.

---

## 1. Objective → production call site

| # | Objective | Owner module | Real call site |
| --- | --- | --- | --- |
| 1 | Runtime-owned liveness | `control-plane/dispatch-liveness-evidence.ts`, `control-plane/liveness-sweep.ts` | `orchestration.await` (each tick) and `orchestration.state`; signals from `orca-runtime.getOrchestrationLivenessSignalSource()` |
| 2 | Runtime-owned waiting | `control-plane/coordinator-await-contract.ts`, `rpc/methods/orchestration-await.ts` | RPC `orchestration.await`, CLI `orca orchestration await` |
| 3 | Builder → reviewer lifecycle | `control-plane/lifecycle-advance.ts` + `-execution.ts`, `control-plane/outcome-policy.ts` | `lifecycle-reconciliation.ts`, immediately after a gate-validated `settleWorkerReport` |
| 4 | Incremental gate receipts | `control-plane/gate-receipt-validity.ts` | recorded from the completion receipt in `lifecycle-advance`; planned via RPC `orchestration.gatePlan` / CLI `orca orchestration gates` |
| 5 | Process-safe validation | `control-plane/validation-lease.ts`, `control-plane/validation-scope.ts` | `orchestration.workerStart` mutation fence; auto-release on completion; RPC/CLI `orchestration validation-lease` |
| 6 | Performance ledger | `control-plane/model-performance-ledger.ts`, `control-plane/dispatch-route-identity.ts` | written per validated completion in `lifecycle-advance` |
| 7 | Live certification ops | `control-plane/certification-admission.ts`, `rpc/methods/orchestration-registry-ops.ts` | RPC `orchestration.routeUpsert` / `certify` / `routes`; CLI `route-upsert`, `certify`, `routes` |
| 8 | Production ownership | `src/main/runtime/orca-runtime.ts` | two narrow accessors added (below) |

---

## 2. Item detail

### 1. Runtime-owned liveness

Signals, all runtime-observed:

- **process/session** — `inspectTerminalProcessIncarnationLiveness`, the same PTY-table probe `worker-release` and `worker-stop` already trust. `unverifiable` never becomes `exited`.
- **last output/activity** — the agent-hook row's `receivedAt`, stamped by the hook server.
- **active tool call** — the hook row's `toolName`.
- **approved blocking wait** — `hasOrchestrationMessageWaiter('dispatch:<id>')`, the runtime's own waiter registry, so `ask` / `check --wait` / `await` are visible without any model claim.
- **provider exit** — the Dispatch row's recorded `termination_reason` (`signaled`/`exited` only; `operator_close` is a deliberate stop).
- **terminal state** — the worker terminal resource's ownership.

State machine: **trigger** = each `orchestration.await` tick plus each `orchestration.state` query (no unconditional background timer — a Run with no subscriber and no query has nothing to wake, and its marker correctly ages out to `unverifiable`). **Clock** = the runtime's `Date.now()`. **Persistence** = `control_plane_dispatch_liveness`, written only by the sweep. **Idempotent transition** = a wake is emitted only on entry to stalled/crashed and recorded in `woke_for`. **Re-arm** = every sweep rewrites `expires_at`. **Shutdown** = `LivenessSweepScheduler.stop()`, idempotent and `unref`-ed. **Terminal resolver** = crashed/settled mark the marker terminal and the store refuses to overwrite it.

`last_heartbeat_at` is not an input anywhere — asserted by a dedicated test.

### 2. Runtime-owned waiting

`orchestration.await` — budget default 6h, max 24h, floor 1 minute. Internal `waitForMessage` slices (30s) exist only so liveness can sweep; a slice expiring never returns to the model. Wakes only for `worker_done`, `question`, `escalation`, and the typed `stalled` / `crashed` / `review_complete` / `ci_blocker` escalations. Takes the same **exclusive** actionable-waiter slot `check --wait` uses, so one Run has one subscription; a second returns `waiter_exists`. `check --wait` behaviour is unchanged.

### 3. Builder → reviewer lifecycle

On a gate-validated completion: build phase → an independent reviewer **Task** is created, bound to the exact delivered SHA (`do not review the branch tip` is in the spec), recorded as a phase row. Reviewer reports `--corrections` → one consolidated FIX_FIRST Task targeting the **same retained builder** (proved directly: `plan.terminalHandle === 'term_builder'`, `plan.route` is the builder's route), whose spec requires rerunning every gate the new commit invalidates. Reviewer reports clean → `review_complete` wake. No certified reviewer route → protected blocker escalation. Idempotent: the unique `(source_dispatch_id, kind)` index makes a replayed completion reuse its phase.

**Candidate order is never invented.** `orchestration.outcomeAdmit` stores the caller's `--reviewer-candidates` / `--builder-candidates` verbatim (test asserts exact order preservation); the control plane only validates them against the certified registry.

### 4/5/6/7

Covered by the table above and the tests below.

### 8. `orca-runtime.ts` changes

Only two additions: `hasOrchestrationMessageWaiter(handle)` and `getOrchestrationLivenessSignalSource()`, plus one constant. No existing runtime behaviour was modified.

---

## 3. Proof at `764d61f4cf`

- `pnpm run tc` (node + cli + web): **0 errors**.
- `pnpm test src/main/runtime/orchestration/ src/main/runtime/rpc/ src/cli/`: **367 files, 3258 passed, 1 skipped, 0 failed** (was 3197 before this correction; +61 new).
- `oxlint src/main src/cli src/shared`: clean. Two files were split rather than suppressed (`lifecycle-advance-execution.ts`, `buildWorkerStartOptions`); **no `max-lines` disable added**.
- `check:code-quality:changed`: 0 new findings across 77 changed files.
- `check:max-lines-ratchet`: OK, no new bypasses. `check:reliability-gates`: 99 gates pass.
- `verify:bundled-skill-guides` and `oxfmt --check`: clean.

### Key negative controls

- No 25/30/60-second value can become the wait budget (clamped up to the 1-minute floor).
- A mailbox of only `status` + `heartbeat` does not end an `await`.
- A second sweep in the same state publishes nothing; a crashed marker cannot be resurrected.
- An active approved wait reads as `blocked_on_approved_wait`, not `stalled`.
- An execution host that throws yields `unverifiable`, never a crash.
- A synthetic Dispatch (no process incarnation) and a Dispatch whose real launch ran a different route both fail PASS certification; `FAIL`/`UNSUPPORTED` are accepted without a launch.
- A legacy Run with no admitted outcome plans nothing and writes no ledger entry.
- An empty reviewer candidate list produces a protected blocker, not a chosen model.
- A different worktree stays writable while a lease is held, so the separate-worktree remedy is real.

---

## 4. Builder-side adversarial review — defects found and fixed in this commit

1. **Local-time timestamp parse.** `dispatched_at` is SQLite's timezone-less UTC space format; `Date.parse` reads it as local time. That skewed the stall window and the ledger wall clock by the host's UTC offset. Fixed with `exposeUtcTimestamp` at both sites, with a regression test pinning `'2026-08-27 11:00:00'` → `'2026-08-27T11:00:00Z'`.
2. **Non-exclusive subscription.** `await` originally registered a non-exclusive waiter, so two subscriptions could be handed the same Delivery and race the acknowledgement. Now exclusive, with a typed `waiter_exists` and a regression test.
3. Federated admission originally spread the whole params object into a typed argument; narrowed to explicit fields.

### Accepted limitations (stated, not hidden)

- The reviewer **phase and Task** are created automatically and bound to the exact SHA; **launching** the reviewer session is still `worker-start` against that Task, because a launch needs a live terminal and worktree placement. The plan names the certified reviewer route to use.
- The liveness sweep runs on subscription and recovery ticks, not on an always-on timer. A stalled worker with no coordinator subscribed and no `state` query is detected on the next tick of either, not sooner.
- Gate `inputHashes` bind the changed-path **set** (hashed paths), not file contents: the runtime cannot read a remote worker's tree. A different file set invalidates the receipt; an edit that changes no path but changes content is caught by the SHA binding instead.

---

## 5. Still incomplete / not ready

- **No route is certified.** Every registry row in a real database remains `UNTESTED` until `orchestration certify` records evidence from a real launch. Nothing here is a PASS for Opus 5, GLM-5.3, Gemini 3.7 Flash, Grok 4.6, Fable or Sol. The certification operations now exist; the live matrix run has not been performed.
- The `orchestration.await` liveness sweep and the reviewer automation have unit and RPC-level integration proof, but **no live end-to-end run against real agent panes** has been executed from this worktree.
