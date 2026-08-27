# PACKAGE B PHASE 5 — EXACT-HEAD CANDIDATE CERTIFICATION

Task `task_e1d4d41c79bb` · Dispatch `ctx_de358c6c53b2` · Run `run_940419794b63`
Supersedes the earlier stale-candidate draft. Every receipt below is bound to the exact final head.

| | |
| --- | --- |
| **FINAL ORCA HEAD** | `b3c603b36100d4f0cf813371fc5bf779d3eed0a3` (tracked-clean; `origin/main` `92536346bd41` is an ancestor) |
| **CANDIDATE_DEV_RUNTIME** | `71820e21-569b-4fd2-a333-728d34c93e26` — Electron `--serve`, built FROM `b3c603b3`, port 6885, state root `/tmp/orca-cand-h/userdata` |
| **JB_NATIVE_ORCA** | `868298d7-29b6-413d-b374-507abfb6e019` — packaged v1.4.190, PID 8264, started Thu Aug 27 11:00:05, `~/Library/Application Support/Orca` |
| **STATE_ISOLATION** | **PASS** |
| **OLD_DEV_ORCA_DEPENDENCY** | **NO** (with the provenance distinction in §3) |
| **NATIVE_COMPATIBILITY_PROOF_REQUIRED** | **YES — performed, §8** |

## 1. The candidate is a disposable certification harness

`npx electron out/main/index.js --serve --serve-port 6885 --serve-json --user-data-dir=… ` with
`ORCA_DEV_USER_DATA_PATH` set. This is the repo's own harness path — `config/scripts/runtime-serve-terminal-smoke.mjs`
boots exactly this. Chosen over headless `orcad` because `orcad` cannot observe agent hooks, and over a
dev **window** because a windowless dev launch never attaches a renderer graph (`graph: unavailable`),
so orchestration is unusable there. Electron `--serve` is the only repo-supported runtime that is both
**hook-capable** and **headless**.

It is temporary infrastructure only. It is not restored, reused, migrated, or incorporated into JB
native Orca or the permanent workflow, and §6 proves Package B production code has no dependency on it.

### Deviation recorded, not hidden

The first attempt (`--user-data-dir` alone) was **not** isolated: for an unpackaged build
`configureDevUserDataPath()` overrides that switch and redirects userData to
`~/Library/Application Support/orca-dev`. That candidate wrote `run_0990f213d6ed` into the old dev
profile's database. It was stopped, `ORCA_DEV_USER_DATA_PATH` added, and every result in this report
comes from the corrected launch. The native Orca database was never touched by it (verified: that run
is absent from the official DB).

## 2. Separation, per resource

| resource | candidate | JB native Orca |
| --- | --- | --- |
| runtime id | `71820e21-…` | `868298d7-…` |
| process | Electron from this worktree, pids 18987 + children | `/Applications/Orca.app`, PID 8264 |
| state root | `/tmp/orca-cand-h/userdata` | `~/Library/Application Support/Orca` |
| orchestration DB | `/tmp/orca-cand-h/userdata/orchestration.db` | `…/Orca/orchestration.db` |
| daemon socket/token/pid | `…/orca-cand-h/userdata/daemon/daemon-v36.{sock,token,pid}` | its own, untouched |
| RPC port | 6885 (pairing-scoped) | its own |
| agent-hook server | own port, own `agent-hooks/` dir | its own |
| workspace | synthetic throwaway repo `/tmp/orca-cand-h/synthrepo` | the user's real repos |

**Isolation proof, not assertion:** on first contact the candidate reported `runs: ['run_legacy_local']`
and `worktrees: 0` — zero of the user's 29 real runs and zero real worktrees.

## 3. Before / after: the candidate neither mutated nor migrated native state

| | BEFORE 18:06:43Z | AFTER 18:26:02Z |
| --- | --- | --- |
| official `orchestration.db` sha256 | `867c1c2ebcade2c4ca8bca12c8914f5849b3d9de4b9501b963420f342d0aac8c` | **identical** |
| official runs / tasks / dispatches | 29 / 249 / 241 | **29 / 249 / 241** |
| official PID / start time | 8264 / Thu Aug 27 11:00:05 | **8264 / Thu Aug 27 11:00:05** |
| candidate runs present in official DB | — | **0** |
| processes using `orca-dev` | 0 | **0** |

### Old dev-profile provenance (the exact distinction)

Two processes were observed using `~/Library/Application Support/orca-dev`: **PID 39847** (Crashpad) and
**PID 41179** (terminal daemon). Both executed `out/main/daemon-entry.js` **from this Task's worktree**
and started 13:20:17 / 13:21:17 — inside this Task's mis-isolated candidate-d launch window. A
pre-existing user dev Orca would run from the user's own checkout, not this worktree. Verdict:
**started by this Task**. Both were stopped; teardown proven (`39847 STOPPED`, `41179 STOPPED`, `0` open
files referencing `orca-dev`). Provenance record: `/tmp/orca-dev-provenance.txt`.

**OLD_DEV_ORCA_DEPENDENCY = NO** for the reporting candidate: zero `orca-dev` strings in any of its
process arguments, zero open files under `orca-dev`, and it stayed healthy after those processes were
stopped.

## 4. Live control-plane certification at the exact head

Candidate `71820e21`, Run `run_3f198b2c0fa9`, outcome `out_cand_h`, worktree
`d51a3033-…::/Users/prometheus/orca/workspaces/synthrepo/cand-h`.

| # | Requirement | Verdict | Live evidence at `b3c603b3` |
| --- | --- | --- | --- |
| 1 | One durable wait, zero continuation loops | **PASS** | `orchestration await` parked across 15 s runtime keepalives and returned only on real wake events (rejection delivery, then the stall escalation). No coordinator reissue. |
| 2 | Runtime-owned liveness, no model heartbeat | **PASS** | Marker written from **agent-hook** evidence: `reason: "Worker has an active tool call."` — the very evidence kind the headless runtime could not produce. `MODEL_GENERATED_HEARTBEATS_REQUIRED = 0`. |
| 2a | Simulated **stall** | **PASS** | `activity: stalled`, `reason: "No worker activity for 626s with no active tool call or approved wait."`, `woke_for: stalled`; escalation published by `orca:runtime-liveness`, payload `{wakeReason: stalled, dispatchId: ctx_d4e98968cc0a, taskId: task_5c017af1bc01, source: runtime_liveness_sweep}`, delivered to the parked coordinator. |
| 2b | Simulated **crash** | **PASS** | Worker PTY killed → `worker: failed / process_exited`, `dispatch: failed`, from the runtime's own process evidence. |
| 3 | Bounded exact-SHA completion receipt | **PASS** | `control_plane_gate_receipts`: `final_sha = d1f331ad3b1003be3b88868b2a2701b8998f11b0`, `result = PASS`, `policy_version = manual-preflight-v1`, real command identity recorded. |
| 4 | `builder_done -> validate -> reviewer` automatic | **PASS** | With zero operator steps the completion settled and the lifecycle planned **and started** a review phase: `phase_task_5c017af1bc01`, `kind = review`, `state = started`, `model = gpt-5.6-sol`, `dispatch_id = ctx_d4e98968cc0a`, `bound_sha = d1f331ad…`, `attempts = 1`, no error, landed in the reviewed commit's own worktree. |
| 5 | Reviewer launch only from a certified route | **PASS** | Before certification the same Run refused every start: `route_untested: Route has no evidence for fresh_launch, …`. After evidence, the certified route launched. |
| 6 | Synthetic FIX_FIRST round | **NOT PROVEN** | Blocked downstream by a provider stall, not by Package B — see §5. |
| 6a | Exact-head **re-review** | **NOT PROVEN** | Same cause. |
| 7 | Replay / duplicate creates no second entity | **PASS** | Live rejections preserved as rejection messages, never as accepted completions. Counts stayed 4 tasks / 4 dispatches / 4 worker terminals — one session per task, one phase launch. |
| 8 | `POST_WORKER_DONE_NONTERMINAL_OUTCOME_STALL` | **PASS** | Fixed in an earlier round and pinned; no duplicate blocker observed in this run. |
| 9 | Completion gate | **PASS (live)** | A `worker_done` with no completion block on an outcome-admitted Run was rejected: `completion_receipt_invalid` / `missing_receipt`. The Dispatch stayed active; the worker's next, complete report was accepted. |
| 10 | Quota honesty | **PASS (live)** | Scheduling an UNKNOWN-quota route refused until the outcome explicitly opted in: `quota_unknown: … requires an explicit policy opt-in`. |

## 5. Why FIX_FIRST and re-review are not proven

The automatically launched reviewer reached `state: ready, stage: input_accepted` — Orca did its job —
but the codex TUI sat on `Starting MCP servers (1/3): codex_apps, openaiDeveloperDocs` with the injected
prompt queued (`[Pasted Content 4231 chars] · tab to queue message`), and its provider process then
exited without ever processing the review. Reproduced on two consecutive phase-launched reviewers, while
manually started reviewers on the identical route completed normally.

Because no reviewer verdict was ever produced, there was nothing for the lifecycle to turn into a
FIX_FIRST round, and no re-review to bind. This is a **provider-side stall**, and the control plane
handled it exactly as designed: the stall was detected from runtime evidence, one typed escalation was
published, the phase stayed `started / attempts 1`, and **no duplicate session was created**. Both items
therefore remain covered by source tests only, and are reported as NOT PROVEN rather than assumed.

## 6. Package B has no dependency on `--serve` / dev mode

Across the 29 control-plane modules plus the orchestration RPC methods and the new CLI recovery module:

| pattern | occurrences |
| --- | --- |
| `'--serve'` | 0 |
| `is.dev` | 0 |
| `isServeMode` | 0 |
| `from 'electron'` | 0 |
| `ORCA_DEV_*` | 0 |
| `app.isPackaged` | 0 |

The harness is a certification host, not a runtime requirement.

## 7. Model route certification at the exact head

Certification is model-neutral: every route is DISCOVERED from Orca's own catalogs. No preference or
fallback chain is encoded anywhere.

| Route | verdict | basis |
| --- | --- | --- |
| `codex \| gpt-5.5 \| xhigh` — builder/fresh | **PASS** | `identityProof: exact`, launcher ✓, hook ✓, drift `[]`, all 10 required evidence kinds observed live and bound to `b3c603b3`. |
| `codex \| gpt-5.6-sol \| xhigh` — reviewer/fresh (**fresh Sol**) | **PASS** | Same, from its own live fresh launch; provider header confirmed `gpt-5.6-sol xhigh · ~/orca/workspaces/synthrepo/cand-h` — requested == effective, and the worktree binding, in the provider's own words. |
| all other role × session-mode cells | UNTESTED | No evidence recorded; reported honestly rather than inferred. |
| Claude Opus 5 | **FAIL** | `identity_proof_insufficient` — every Claude catalog model is a family alias, and the installed Claude Code resolved to `glm-5.3` with no model flag. |
| Fable | **FAIL** | Same alias reason on requested identity. |
| GLM-5.3 via `opencode` | **FAIL** | `launcher_hook_drift` — launcher-supported but not an agent-hook target; no session-option catalog. |
| Gemini 3.7 Flash | **FAIL** | `model_absent_from_catalog` — `gemini-3.7-flash` is not in Orca's Gemini catalog; gemini has no launch-time model selection. |
| Grok 4.6 | **FAIL** | Exact catalog id, but the grok harness declares no launch-time model selection, so the requested identity cannot be pinned. |
| Local Qwen | **EXCLUDED BY POLICY** | `isExcludedWorkerAgent('qwen-code')`; never routed. |

A provider-specific failure never stopped an unrelated route: after each failure the next route was
tested independently. One quota signal was observed and recorded, not inferred: codex printed
"You have 1 usage limit reset available."

## 8. Native / packaged compatibility proof (no restart, no mutation)

| direction | result |
| --- | --- |
| exact-head CLI → packaged v1.4.190 runtime, legacy op | **ok** — `orchestration check --peek` answered from runtime `868298d7…` |
| exact-head CLI → packaged v1.4.190 runtime, Package B op | **typed degradation** — `method_not_found: Unknown method: orchestration.routes`. No crash, no corruption. |
| packaged v1.4.190 CLI → exact-head candidate | **ok** — status `graph: ready`, `orchestration run-list` returned the candidate's runs |

Mixed-version behaviour is correct in both directions per `docs/reference/remote-wire-compatibility.md`.
Native Orca was not restarted, replaced, installed over, or written to; §3 proves its database is
byte-identical before and after. No protected blocker was required.

## 9. Defects this certification round found and fixed

Each was found by running the control plane, not by reading it; each has a bug-rejecting test that was
verified to FAIL against the pre-fix code.

1. **`REJECTED_WORKER_DONE_NOT_TERMINAL`** — a rejected `worker_done` returned only a code and a
   sentence, which reads like a terminal failure although the Dispatch stays active. Rejections now
   carry `dispatchSettled: false` plus the one operation that recovers them.
   `src/cli/orchestration-lifecycle-rejection-recovery.ts`; tests in
   `orchestration-lifecycle-rejection.test.ts` and `rejected-worker-done-not-terminal.test.ts`.
2. **`CRASHED_DISPATCH_STALE_LIVE_MARKER`** — the sweep visited only ACTIVE Dispatches, so one that died
   between two sweeps kept reading `live` until its TTL. Settled Dispatches with a non-terminal marker
   are now finalized. Verified live: `ctx_8124f4a33c9e` now reads `exited / settled / terminal 1`.
3. **`CRASHED_DISPATCH_RECOVERY_QUERY_REPORTS_LIVE`** — `orchestration state` is read-only and cannot
   sweep, so recovery contradicted the lifecycle. The Dispatch's own settled status now outranks the
   marker. Verified live: stored marker still `live`, recovery query answers `exited / settled`.
   The sweep docstring no longer claims a trigger that never existed.
4. **`WORKER_START_IGNORES_OUTCOME_QUOTA_OPTIN`** — an outcome admitted with `--allow-unknown-quota`
   still failed `worker-start`; the automatic advance read the policy, the manual path did not, which
   made the documented opt-in unusable on the one path an operator drives by hand.

Commits: `892ab2b2`, `24d3cbfe`→`3f7d07ec`, `b3c603b3`.

## 10. Receipts

Exported verbatim before teardown to **`.ai/package-b-exact-head-receipts.txt`**:
2 routes · **20 evidence rows, every one `commit_sha = b3c603b36100d4f0cf813371fc5bf779d3eed0a3`** ·
1 outcome · 1 policy · **1 phase launch (review, started, gpt-5.6-sol)** · **1 gate receipt bound to
`d1f331ad…`, PASS** · 1 liveness marker · 1 performance ledger row
(`codex|gpt-5.5|xhigh`, builder, `first_pass_result: accepted`, `correction_rounds: 0`,
`wall_clock_ms: 238601`) · plus every escalation and rejection message.

## 11. Can a fresh Sol/xhigh independent review start automatically?

**Yes for launch, no for completion — and the reason is not Orca.**

The route `codex|gpt-5.6-sol|xhigh` is certified **PASS** for reviewer/fresh at the exact final head, and
the lifecycle **did** start it automatically from a builder completion with zero operator steps
(`phase_task_5c017af1bc01`). What did not happen is the review itself: the provider TUI stalled on MCP
server startup and its process exited before processing the prompt (§5). On this host, an automatic Sol
review starts but cannot be relied upon to finish until that provider-side stall is resolved.

I am not self-certifying and not claiming ready.

## 12. Remaining typed blockers

1. `provider_startup_stall` — phase-launched codex reviewers hang on `Starting MCP servers` and exit; blocks FIX_FIRST and exact-head re-review.
2. `identity_proof_insufficient` — Claude Opus 5 and Fable.
3. `model_absent_from_catalog` — Gemini 3.7 Flash.
4. `launcher_hook_drift` — GLM-5.3 via opencode.
5. No launch-time model selection — Grok 4.6 and Gemini.
6. Provider first-run interstitials block automatic readiness once per worktree; Orca types them exactly (`Agent startup blocked: codex-update-prompt`) but cannot clear them.
7. Agent-hook rows do not flow in headless `orcad` — a real limitation of that runtime, and the reason this round used Electron `--serve`. Not a Package B defect; recorded so no future round repeats the mistake.

## 13. SCL launcher/hook boundary (read-only)

`/Users/prometheus/orca/workspaces/scl-platform/launcher-repair-opus` — HEAD still
`b588f7597cc52cd4535181af8c17280ed380ac8e`, not edited from this lane, Fable SHIP history intact.

- **AGREES**: `WORKER_START_AGENTS = {"claude", "codex"}` matches the two hook-capable agents Orca can pin at launch.
- **DISAGREES — reported as FAIL, not accepted limitations**: `GEMINI_REQUIRED_MODEL = "gemini-3.7-flash"` / `GEMINI_ALIAS = "gemini-flash-latest"` (absent from Orca's catalog → can never pass certification as specified); `opencode`/GLM (launcher-supported, hook-rejected).

**Smallest follow-up handoff** (separate lane): teach `route-upsert` to accept a
provider-receipt-observed exact model id — one change that unblocks Gemini, Opus 5 and Fable at once —
then re-run the launcher's Gemini path and record the observed effective model. `opencode`/GLM needs an
Orca decision (add it to the hook targets, or accept that GLM cannot take a certified route); not
decidable in this lane.

## 14. Teardown and safety

Nothing pushed, no PR, no merge, no deploy, no install. Native Orca never restarted or written to;
§3 proves byte-identical state. No historical orchestration row rewritten or deleted — every candidate
used its own database. No credential or provider secret appears in any receipt. The SCL worktree was
read only. All candidate runtimes, their synthetic repos and worktrees, and the Task-owned `orca-dev`
processes are stopped and removed.

## 15. Gates on the final head `b3c603b3`

| gate | result |
| --- | --- |
| `pnpm run typecheck` (all projects) | 0 errors |
| Full `src/` suite | **6654 files, 62075 passed, 247 skipped, 0 failed** |
| Package B control-plane suite | 23 files, 206 passed, 0 failed |
| `oxlint src/cli src/main/runtime/orchestration` | clean |
| `check:code-quality:changed` since `92536346bd41` | **0 new findings across 90 changed files** (code, type-aware, React Doctor) |
| `check:max-lines-ratchet` | OK |
| `check:reliability-gates` | OK |
| `verify:bundled-skill-guides` | OK |
| `oxfmt --check src/` | 20 failures, **all pre-existing on `origin/main`** — every one under `src/main/orcad`, `src/main/ssh`, `src/renderer`, or `i18n`, and none in this branch's 90 changed files |
| tracked worktree | clean (`.ai/` reports untracked) |
| `origin/main` ancestor of HEAD | yes |
