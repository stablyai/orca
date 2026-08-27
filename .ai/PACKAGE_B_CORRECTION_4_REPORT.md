# PACKAGE B — CORRECTION 4 REPORT (upstream reconciliation gate)

Task `task_1c37e3e98f04` · Dispatch `ctx_c69eba080d9f`
Branch `jb-workflow-control-plane-b`
**Reconciled HEAD `b8e8f5a7096a6cbd2e34f571e00ec22499e1b5b6`** · tracked worktree **clean**
`origin/main` (`92536346bd414d37afeadb5b69c2171b1179cbd3`) **is an ancestor of HEAD** ✓

Chain: base `026389a3bc03` → c1 `9dbc4f6af4` → c2 `764d61f4cf` → c3 `4e5e8247aa`
→ merge `70168308a9` → format `b8e8f5a709`. All three Package B commits are still present at their **original SHAs**.

## 0. Mailbox

`orca orchestration check` was run twice (consuming) before and during the work: **empty both times**
(`run_940419794b63`, `count: 0`). The reconciliation requirement arrived in this Dispatch's TASK block,
not as a queued control message. Runtime id observed: `868298d7-29b6-413d-b374-507abfb6e019` — matches
the coordinator's captured evidence.

## 1. Refs verified independently

| ref | SHA | relationship |
| --- | --- | --- |
| Package B base | `026389a3bc03` | ancestor of `origin/main` ✓ |
| coordinator's fetched main | `07b7e9e68d` | ancestor of current `origin/main` ✓ |
| **current `origin/main`** | `92536346bd` | **advanced by 1 commit during this gate** |
| tag `v1.4.190` | `6e4f817101` | **NOT an ancestor of `origin/main`** |

Two corrections to the briefed evidence, both material:

1. **Upstream advanced.** `origin/main` is now `92536346bd`, one commit past the briefed `07b7e9e68d`.
   I reconciled onto the **exact current** `origin/main` (a superset), which is what makes requirement 3
   literally true.
2. **`v1.4.190` is not on the main line.** The tag and `origin/main` diverge at `e50cc309c3`; the tag is
   13 commits along a release branch, `origin/main` is 227 commits along its own. `origin/main:package.json`
   still reads `1.4.178-rc.2`, `v1.4.190:package.json` reads `1.4.190`. The Package B base is **not** an
   ancestor of the tag. So "official v1.4.190" and "current main" are two different trees and are
   classified separately below.

**All nine substantive v1.4.190 commits are already ancestors of the Package B base** (`#16550, #16570,
#16569, #16345, #16450, #16414, #15172, #16149, #16057, #16138` → verified `ALREADY-IN-PACKAGE-B-BASE`).
Only two release-branch-only commits are not in main:

- `ef7cd03ab8 fix(terminal): tear down failed local exits after input` — renderer `pty-connection.ts` only.
- `86114e6787 fix(release): accept providerExitObserved without STA-4612's reconciliation` — its own message
  states the release **deliberately excludes** #15212's behaviour and only widens an option type so the
  #15172 split typechecks. `#15212 (94f231737d)` **is already in the Package B base**, so main — and
  therefore Package B — carries the real reconciliation the release omits. The release shim is strictly
  weaker; there is nothing to port.

## 2. Semantic overlap analysis (not name-based)

`026389a3bc03..92536346bd` = 2 commits, 12 files, 1222 diff lines: browser link/popup routing, page-initiated
tab budget, a renderer IPC bridge, an e2e browser spec, and the runtime-client export-parity test.

- Textual overlap with the 86-file Package B diff: **zero** (`comm -12` empty).
- Content probe of the **full 1222-line upstream diff** for Package B concepts —
  `orchestration`, `dispatch_contexts`, `worker_done`, `workerStart`, `liveness`, `heartbeat`,
  `control_plane`, `phase_launch`, `validation_lease`, `certif`, `Delivery`, `waitForMessage`,
  `notifyMessageArrived`, `getOrchestrationDb`: **0 occurrences of every one**.
- Probe for the runtime symbols Package B consumes —
  `inspectTerminalProcessIncarnationLiveness`, `getAgentStatusSnapshot`, `sendTerminalAgentPrompt`,
  `createTerminal`, `waitForTerminal`, `getOrchestrationDispatchAuthority`: **0 occurrences**.

**Bonus:** upstream `92536346bd` fixes `src/shared/runtime-client-export-parity.test.ts` — the single
pre-existing failure reported against every prior Package B commit. It now **passes** on the reconciled head.

## 3. Reconciliation method

**Merge, not rebase** (`git merge --no-ff origin/main`, no conflicts). The task required a non-destructive
method that does not rewrite historical Package B commits; a rebase would have re-minted the three SHAs the
Control Room has been verifying. The merge makes `origin/main` an ancestor of HEAD, preserves every upstream
fix, and leaves `9dbc4f6af4` / `764d61f4cf` / `4e5e8247aa` intact. Merge commits are an accepted shape in this
repo (6 in the last 200 commits on main).

## 4. Requirement classification vs official v1.4.190 and current main

Evidence is `git grep` over each ref's tree, not release language.

| Package B requirement | vs `v1.4.190` | vs current `origin/main` | evidence |
| --- | --- | --- | --- |
| B1 role/model certification registry | UNRELATED | UNRELATED | `control_plane_`, `routeUpsert`, `phase_launch`, `validation_lease`: **0 files** in both refs. The 8 `certification` string hits in main are codex-session backfill and PTY replay guards — a different domain. |
| B2 outcome identity / one durable Run | UNRELATED | UNRELATED | `outcome_id`: **0 files** under `src/main/runtime/orchestration` in main. |
| B3 runtime-owned waiting | PARTIAL_OVERLAP | PARTIAL_OVERLAP | Upstream owns the substrate Package B builds on and preserves (`getOrCreateRunDelivery`, `waitForMessage`, `check --wait`). It does **not** provide the durable subscription or the canonical wake set: `orchestration.await`, `COORDINATOR_WAKE`, `wakeReason` = **0 files** in both refs. |
| B4 runtime-owned liveness, no model heartbeat | PARTIAL_OVERLAP (divergent) | PARTIAL_OVERLAP (divergent) | Both upstream refs still carry the model-heartbeat requirement in `preamble.ts` (**3 hits each**); reconciled HEAD has **0**. This is a deliberate Package B divergence, not a merge conflict — the merge never touched `preamble.ts`. Separately, `v1.4.190`'s `86114e6787` accepts `providerExitObserved` but explicitly excludes STA-4612's reconciliation, which main already has (#15212 in the Package B base) and which Package B's liveness classifier consumes. |
| B5 compressed worker protocol | PARTIAL_OVERLAP (divergent) | PARTIAL_OVERLAP (divergent) | Upstream has `preamble.ts`; Package B replaces its shape (typed `report`/`escalate`, retained delta). Same file, no merge contention. |
| B6 authoritative completion receipt | UNRELATED | UNRELATED | Upstream `settleWorkerReport` exists as the settle primitive Package B gates in front of; no SHA/receipt validation anywhere (`completion receipt`: 0 files). |
| B7 builder→reviewer + FIX_FIRST automation | UNRELATED | UNRELATED | `outcomeAdmit`, `gatePlan`: **0 files**. The single `reviewer` hit in main's orchestration tree is `groups.test.ts` group addressing. |
| B8 incremental gate receipts | UNRELATED | UNRELATED | `control_plane_gate_receipts`: 0 files in both refs. |
| B9 validation lease / mutation fence | UNRELATED | UNRELATED | `validation_lease`: 0 files in both refs. |
| B10 bounded state recovery | UNRELATED | UNRELATED | `orchestration.state` / recovery record: 0 files in both refs. |
| Upstream browser/popup range itself | — | UNRELATED to every Package B requirement | 0 orchestration symbols across the whole 1222-line diff. |

**No CONFLICT and no SOLVES for any requirement.** Nothing upstream implements a Package B requirement, and
nothing upstream contradicts one. The two PARTIAL_OVERLAP-divergent rows (B4, B5) are intentional Package B
replacements of upstream preamble behaviour, and they merged cleanly.

## 5. Gates on the exact reconciled HEAD `b8e8f5a709`

| gate | result |
| --- | --- |
| `pnpm run tc` (node + cli + web) | **0 errors** |
| **Full `src/` suite** | **6650 files, 62059 passed, 251 skipped, 0 failed** |
| Package B affected suites | 369 files, 3280 passed, 1 skipped, 0 failed |
| Upstream-invalidated areas (`src/main/browser`, renderer IPC hooks) | 170 files, 1508 passed, 0 failed |
| Previously-failing `runtime-client-export-parity` | **now passes** (2/2) — fixed by upstream `92536346bd` |
| `oxlint src/main src/cli src/shared` | clean |
| `check:code-quality:changed` | 0 new findings, 83 files, **since `92536346bd41`** |
| `check:max-lines-ratchet` | OK, no new bypasses |
| `check:reliability-gates` | 99 gates pass |
| `verify:bundled-skill-guides`, `verify:skill-bundle-manifest` | clean |
| `oxfmt --check` on all 84 Package B files | clean |

**This is the first fully green run of the whole suite in Package B** — the long-standing single failure was
upstream's, and reconciling removed it.

## 6. Defect found and fixed during this gate

`oxfmt --check` over the **full** `src` tree found **18 Package B files with formatting drift**. Earlier
corrections ran the format check only over `git status` output, which is empty after a commit, so drift
introduced by post-format edits to already-committed files was never visible. Fixed in `b8e8f5a709`
(formatting only; typecheck, lint and the 3280-test affected suite re-run green afterwards). The 20 remaining
`oxfmt --check src` failures are **pre-existing on `origin/main` itself** (verified in a throwaway worktree at
`origin/main`) and were deliberately left untouched.

## 7. Still incomplete — not ready

Unchanged by this gate, and reconciliation does not alter any of it:

- **No route is certified.** Every registry row is `UNTESTED` until `orchestration certify` records evidence
  from a real launch. Nothing here is a PASS for Opus 5, GLM-5.3, Gemini 3.7 Flash, Grok 4.6, Fable or Sol,
  and the automatic lifecycle correctly emits the protected blocker rather than starting anything.
- **Outcome admission is operator-initiated** (`orchestration outcome-admit` with the reviewer candidate order),
  once per outcome.
- **No live end-to-end run against real agent panes.** The autostart proof drives the real `workerStart`
  handler against a mocked terminal layer.
- Not pushed, no PR opened, app not restarted, worker not replaced.
