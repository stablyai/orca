# PACKAGE B — CORRECTION 3 REPORT

Task `task_1543e826adf4` · Dispatch `ctx_b50bd5f6277a`
Branch `jb-workflow-control-plane-b`
Base `026389a3bc03` → c1 `9dbc4f6af4` → c2 `764d61f4cf` → **c3 `4e5e8247aae17dab861c82a819f91ec6e17c4c13`**
Tracked worktree: **clean** (only untracked `.ai/` docs). Diff vs c2: 22 files, +1816 / −34.

---

## 1. The gap this closes

Correction 2 created the reviewer and FIX_FIRST **Tasks** and then stopped; its own report said a
human or coordinator still had to call `worker-start`. The runtime now starts them.

| Requirement | Where it lives | Started by |
| --- | --- | --- |
| 1. Create **and start** the fresh reviewer | `phase-launch-driver.ts` + `orchestration-phase-launch.ts` | `orchestration.await` tick, the completion send path, `orchestration phase-launch` |
| 2. FIX_FIRST **dispatches** to the retained builder | same driver, `terminal_handle` on the launch row | same |
| 3. Corrected completion → invalidated gates rerun → review again on the new SHA | `lifecycle-advance.ts` + `gate-receipt-validity.ts` | same |
| 4. Every loop edge defined | `phase-launch-store.ts` header + table | — |
| 5. Uncertified role → protected blocker | driver `blocked` path | — |
| 6. Lease / liveness / history / Qwen preserved | unchanged from c1/c2 | — |

**No parallel launcher.** The driver calls the existing `orchestration.workerStart` handler with the
same params a coordinator would send, so worktree placement, admission, capability minting, readiness
waiting and the retained-session path are all the ones already in production.

---

## 2. Loop edges (all persisted in `control_plane_phase_launches`)

| trigger | immediate state | writer | next state |
| --- | --- | --- | --- |
| phase created by the lifecycle | `pending` | `recordPlanned` | `starting` |
| driver claims the launch | `starting` | `claimForStart` | `started` / `start_unknown` / `failed` |
| worker-start returned a Dispatch | `started` | `markStarted` | terminal |
| worker-start response lost | `start_unknown` | `markOutcome` | `started` (reconciled) / `failed` |
| no certified route for the role | `blocked` | `markOutcome` | `started` once certified |
| attempts exhausted | `failed` | `markOutcome` | terminal |

- **Authoritative clock**: the runtime's, passed in as `nowMs`.
- **Idempotency key**: `phase_id`, plus a UNIQUE index on `task_id` so a replayed plan cannot fork a second launch.
- **Concurrency**: the claim IS the conditional `UPDATE`'s changed-row count. Two racing drivers cannot both win.
- **Retry/recovery**: the driver hands worker-start a durable mutation request id derived from the phase id. A retry re-presents the same id, so worker-start's own receipt store replays the accepted Dispatch or refuses the duplicate; the driver adopts the original. A thrown start is `unknown`, never `failed`, so it can still reconcile. **It never creates a replacement.**
- **Re-arm**: `pending`, `start_unknown` and `blocked` are picked up again; `blocked` does not consume the retry budget and publishes its blocker only on the transition.
- **Terminal resolver**: `started` and `failed`.

---

## 3. Behaviour detail

**Reviewer** — an independent FRESH session on the certified reviewer route the plan selected, in the
worktree holding the reviewed commit (`worktree_id` on the launch row, not the coordinator's tree),
bound to the exact SHA. Role and session mode come from the Task's own phase, so admission demands a
certified `reviewer`/`fresh` route rather than the builder default.

**FIX_FIRST** — dispatched to the SAME retained builder terminal. worker-start reuses that session via
`--terminal`, and the pane receives only the dispatch delta plus the corrections — never the lifecycle
manual again. The retained route is admitted as `builder`/`retained` from the plan, because a
`--terminal` reuse cannot restate `--agent`.

**Second round** — a corrected completion invalidates the receipts bound to the old SHA, validates the
new HEAD, and automatically starts the independent reviewer again on that exact commit.

**Uncertified role** — the driver emits the existing protected blocker and starts nothing. No fallback
to UNTESTED, stale, quota-blocked or role-inappropriate routes.

---

## 4. Proof at `4e5e8247aa`

- `pnpm run tc` (node + cli + web): **0 errors**.
- Affected suites (`orchestration/`, `rpc/`, `cli/`): **369 files, 3280 passed, 1 skipped, 0 failed** (+22 vs c2).
- Whole `src/` suite: **6647 files, 62051 passed, 251 skipped, 1 failed** — that one is
  `src/shared/runtime-client-export-parity.test.ts`, verified failing on the base commit itself in a
  throwaway worktree during correction 2. This branch still changes **no** `src/shared` file
  (`git diff --name-only 026389a3bc03 -- src/shared/` is empty).
- `oxlint`, `check:code-quality:changed` (0 new findings, 83 files), `check:max-lines-ratchet`
  (no new bypasses), `check:reliability-gates` (99), `verify:bundled-skill-guides`, `oxfmt --check`:
  all clean. Two files were split rather than suppressed; **no `max-lines` disable added**.

### Bug-rejecting tests (the ones the correction asked for)

- *Merely creating a Task is insufficient* — a planned phase that is never driven stays `pending` with no Dispatch and remains actionable. This is the exact c2 gap, asserted.
- *The reviewer actually starts once* — end-to-end through the real `workerStart` handler: launch row goes `pending` → `started`, a real Dispatch row exists, the prompt contains the bound SHA, and `start_options.launch.effective` is the certified reviewer route.
- *Replay creates zero duplicates* — driving three times calls start once; replaying the plan cannot fork a second row; driving twice after a completion leaves one Dispatch and one prompt.
- *FIX_FIRST reaches the original retained builder exactly once* — three replayed review completions produce one `fix_first` launch and one prompt, to `term_builder`, containing `=== NEW DISPATCH ===` and the corrections but **not** `=== CLI COMMANDS ===`.
- Plus: two concurrent drivers start exactly once (max in-flight 1); a lost response reconciles to the original Dispatch and the replacement start is never called; a thrown start parks as `unknown`; the budget exhausts to `failed` and stays terminal; a blocked phase publishes one blocker then starts once certified; an uncertified reviewer launches nothing at all.

---

## 5. Builder-side adversarial review — defects found and fixed in this commit

1. **Double-claim race.** `claimForStart` ran a conditional UPDATE and then *read the state back*. The
   losing driver would see the winner's `starting` and believe it had won, starting a second session.
   Now the claim is the UPDATE's own `changes === 1`. Regression test drives two concurrently and
   asserts max-in-flight 1.
2. **Reviewer exclusion keyed on the wrong route.** The "don't let a session grade its own work" filter
   used the phase's source Dispatch. After a correction round that source is the *reviewer*, so the
   reviewer excluded itself and the second review was blocked outright — the third requirement would
   have silently failed. It now excludes the route that **wrote** the commit, with a negative-control
   test showing the authoring route would otherwise be chosen.
3. **Blocked phases burned the retry budget** and re-published their blocker every tick. A block is an
   external condition, so it now resets attempts and publishes only on the transition.
4. **Reviewer landed in the coordinator's worktree.** Now bound to the worktree holding the reviewed
   commit.
5. **`recordPlanned` could return `undefined`** when the UNIQUE index swallowed an insert; it now falls
   back to the existing launch for that Task.

### Accepted limitations

- The send-path trigger is fire-and-forget (a reporting worker must not block on a reviewer's readiness
  wait); the `orchestration.await` tick is the durable re-arm, so a dropped promise costs latency, never
  the launch.
- A Run whose coordinator terminal handle is unset launches nothing and retries next tick.
- `blocked` is re-armable by design; `failed` is terminal and needs an operator, by design.

---

## 6. Remaining manual lifecycle steps — reported as incomplete, not ready

- **Certification is still manual and unperformed.** Every registry row in a real database is
  `UNTESTED` until `orchestration certify` records evidence from a real launch. Until a route is
  certified for its role, the automatic lifecycle correctly emits the protected blocker instead of
  starting anything. Nothing here is a PASS for Opus 5, GLM-5.3, Gemini 3.7 Flash, Grok 4.6, Fable or Sol.
- **Outcome admission is operator-initiated.** `orchestration outcome-admit` (with the reviewer
  candidate order) must be run once per outcome; without it the Run keeps legacy behaviour and no
  automatic lifecycle runs.
- **No live end-to-end run against real agent panes** has been executed from this worktree. The
  autostart proof runs the real `workerStart` handler against a mocked terminal layer.
