# Package B consolidated core correction - final report

Task `task_2523bb30104c` - Dispatch `ctx_cfb69a42239a` - Run `run_940419794b63`
Retained Opus session, one worktree, one branch throughout.

| | |
| --- | --- |
| **Required base** | `fecdf0bde8850b81403df4609fbc98d0e805f31f` - reconciled non-destructively by merge at `1fa89e1f4d`; it is an ancestor of HEAD |
| **Final HEAD** | `b954873e838366b275117d7cdc06f03cd9d8fb1f` |
| Correction commits | `65a10dccc4` (seven core fixes), `4a0cae2626` (route truth + completion-receipt fingerprint), `29bd5cfa72` (runtime owns its commit), `8ede73cf6d` (ten findings), `b954873e83` (two launch strategies + contract wiring) |
| Worktree state | tracked-clean; only `.ai/` reports untracked |
| **Candidate** | `f6b1a602-f4d5-4156-8489-e1d86df2fc9d` - Electron `--serve`, built from `8ede73cf6d`, port 6891, state root `/tmp/orca-cand-k/userdata` |
| Runtime identity it stamps | `43.1.0+890ce4f878008444+8ede73cf6df44c5bb3628673d316947e155ef051` |
| Native Orca | v1.4.190, PID 8264, started 11:00:05 - never restarted, replaced or written to by the candidate |

## The seven core defects

1. **Certification event integrity.** Evidence was caller-declared: one real launch let a caller
   mint PASS for all ten kinds. Each kind is now derived from a runtime-owned event, and a kind the
   runtime cannot observe fails closed. Proven live twice over: the same six calls that were REFUSED
   before the events happened were ADMITTED afterwards.
2. **SHA and runtime binding.** Worker-start passed no SHA or runtime identity at all, so evidence
   from any commit or build read as current. The runtime now resolves the commit it was built from,
   carries it in its identity, and rejects a mismatched claim **at record time**.
3. **Real incremental gate validity.** Receipts fingerprinted the path *string*, shared one input set
   across every gate, and died with any SHA. They now fingerprint file **bytes** per gate, plus gate
   configuration; a correction invalidates only the gates whose own dependencies moved; publication
   and review gates stay bound to their exact head.
4. **Validation mutation fence.** The fence was consulted only when a start named an explicit
   worktree, so re-engaging an already-running builder bypassed it. It now resolves the retained
   worktree, and lease ownership is real.
5. **Terminal-output liveness.** Activity came only from the agent-hook stamp, so a worker visibly
   producing output aged into a stall. Liveness now takes the newest of every authoritative source
   Orca owns, including its own PTY observation. Model heartbeats stay excluded.
6. **Operational 2-5 outcome intake.** The function had no production operation and admitted
   outcomes one at a time. It is now `orchestration.outcomeIntake` / `orca orchestration
   outcome-intake`, wrapped in one transaction.
7. **Failed work never advances.** The advance planned the next phase from the mere arrival of a
   completion. It now requires an accepted completion, a succeeded outcome and a gate that did not
   fail; every typed non-success state settles with one deduped escalation and creates no reviewer.

The literal NUL byte in `outcome-identity.ts` is gone - the domain separator is written as a
unicode escape, so the file is UTF-8 text while hashing byte-identical input (pinned by a test).

Fixing 7 exposed a **stale read**: the advance was handed the pre-settlement dispatch row, so its
status check would have blocked every advance. Fixed at the source.

## Live receipts, all bound to `8ede73cf6d`

| Receipt | Live result on candidate `f6b1a602` |
| --- | --- |
| `CERTIFICATION_EVENT_INTEGRITY` | All seven claimed kinds REFUSED with distinct typed reasons, including *"has a tool event but no recorded PreTool acceptance decision"* and *"has a launch token but no recorded safe-launch admission"*. |
| `SHA_RUNTIME_BINDING` | A `cccc...` claim refused: *"Evidence claims commit cccc..., but this runtime was built from 8ede73cf6d..."*. The correct claim stamped `commitSha = 8ede73cf6d...` and runtime `43.1.0+890ce4f878008444+8ede73cf6d...`. |
| `INCREMENTAL_GATE_REUSE` | Changed only `x.ts`, SHA moved: `gate-x` reran (`Inputs changed: file:x.ts`), `gate-y` **reused across the SHA**, `review-gate` reran (bound to exact head). A gate with no declared inputs refused outright. |
| `VALIDATION_MUTATION_FENCE` | Fake owner refused; `--ttl-ms 0` refused; guard `allowed:false` with both remedies; **re-engaging the running builder refused** naming the lease; release without owner refused; rightful owner released. |
| `TERMINAL_OUTPUT_LIVENESS` | **Both halves.** Output with no new hook event gave `live/working`, *"Worker produced output within the stall window"*. After silencing the provider, at 20:47:41Z it became `stalled`, *"No worker activity for 643s with no active tool call or approved wait"*, `woke_for=stalled`, and the escalation `Worker stalled: dispatch ctx_d68b6fe7d0e0` was published. |
| `BATCH_2_TO_5_INTAKE` | 3 outcomes admitted atomically to 3 distinct Runs with a `serialize` decision recorded; identical replay idempotent; **same batch id with a different manifest refused**; undecided overlap refused leaving 0 admitted. |
| `FAILED_WORK_NO_REVIEW` | Builder reported `--outcome failed`: **0** review phases, **0** outcome phases, **0** reviewer sessions, one `Protected blocker: completion_not_accepted` with `protectedBlocker:true`. |
| `ORCA_NATIVE_ROUTE_TRUTH` | Eight routes classified from Orca's own catalogs; matches the source-derived table exactly. |

## Prior core smoke, re-run at this head

Durable wait, runtime liveness, stall, rejected completion (a `Rejected worker_done` was preserved
and the Dispatch stayed active), duplicate prevention, state isolation (`runs: ['run_legacy_local']`
and `worktrees: 0` on first contact), no old Dev Orca dependency (zero processes, zero open files),
and native compatibility in both directions - the new CLI runs a legacy op against v1.4.190 and a
new op degrades to `method_not_found`, while the packaged v1.4.190 CLI reaches the candidate with
`graph: ready`.

**Automatic builder-to-reviewer was NOT re-proven, and the reason is this correction working.**
See below.

The official database changed hash during the run. That is **my own dispatch traffic** - 76 messages
on `run_940419794b63`, the newest being my heartbeats. Every one of the candidate's six Runs is
absent from it; `run_legacy_local` exists in both only as a per-runtime bootstrap sentinel with
different `created_at` and text.

## The headline consequence

After this correction **no route can reach full certification on any runtime that does not record a
provider-observed effective identity, an accepted PreTool decision, and a safe-launch admission.**
Orca records none of the three today. Concretely, on the candidate every outcome-bound
`worker-start` refuses with:

> `route_untested: Route has no evidence for effective_model_identity, effective_reasoning_mode, pretool_acceptance, safe_launch_acceptance, ...`

That is the intended fail-closed behaviour - it is the fix for defect 1 - but it means the
outcome-bound launch path cannot run end to end, so the automatic reviewer and the live `serialize`
gate could not be exercised. Both are proven deterministically instead
(`outcome-serialization.test.ts`, `lifecycle-advance.test.ts`), each with a control that fails
against the pre-fix code.

**The smallest unblocking change** is for the runtime to record three events it already witnesses:
the provider-reported effective identity at session start, the PreTool decision the hook server
already makes, and the safe-launch admission `assertWorkerStartAdmitted` already computes. None
requires provider work; all three are Orca-side records.

## Native route truth and policy drift

Full evidence table, root causes and the SCL handoff are in
**`.ai/PACKAGE_B_ROUTE_DRIFT_ADDENDUM.md`**. Headlines:

- **Opus, Fable and Sol/Codex are `NATIVE_ROUTE_SUPPORTED`** - my earlier phase-5 report was wrong.
- **Gemini Flash and Grok are `BLOCKED_SAFE_LAUNCH_POLICY_DRIFT`**, not provider incapability: both
  catalogs seed the model and can pin it; only the unattended-launch opt-in is absent.
- **GLM-5.3/opencode is `IDENTITY_PROOF_INCOMPLETE`, not `TRULY_UNSUPPORTED`** - correcting my own
  error, which was the same drift class this work exists to remove.
- **`PRETOOL_DRIFT_ROOT_CAUSE`**: SCL's `valid_routes` has no `codex` tuple, so the one route Package
  B certifies is denied - baked in at `5629171c` and untouched by three later launcher-repair
  commits.
- **`SINGLE_ROUTE_CONTRACT`**: `classifyNativeRoute` plus `orchestration.routeTruth` give external
  policy something to derive from instead of hand-maintaining a copy.

## Ten reviewer findings

All ten verified TRUE against source by independent read-only sweeps, all fixed, each with a
negative control observed failing against pre-fix code. The most consequential: `serialize`
decisions were stored and read by nothing, so two outcomes an operator said must not run together
would both launch.

## Safety

No push, no PR, no merge, no deploy, no install, no restart of native Orca. No historical
orchestration row rewritten. No credential in any receipt. The SCL worktree was read only and is
still at `b588f7597cc5`, clean. Same Run, Task, Dispatch and retained terminal throughout; no
replacement Run, worker, adapter or architecture lane was created. Subagents were used only for
read-only investigation and test triage, and every result was verified before use.


## Head binding of the receipts

Two candidates were used, and the report is explicit about which head each receipt binds to.

- **`b954873e83` (definitive head)** — candidate `76436d24-c160-4b3e-8331-096134a92f73`, runtime
  identity `43.1.0+2b98211428942c45+b954873e83...`. Re-proven here: `ORCA_NATIVE_ROUTE_TRUTH`
  (all six routes, now carrying `launchStrategies` and `nativeLaunchPossible`),
  `SHA_RUNTIME_BINDING` (a `dddd...` claim refused, the correct claim stamped `b954873e83...`),
  `TERMINAL_OUTPUT_LIVENESS` first half (`live/working`, *"Worker produced output within the stall
  window"*), and zero review phases / outcome phases / reviewer sessions on the outcome-bound Run.
  Receipts exported to `.ai/package-b-definitive-head-receipts.txt`.
- **`8ede73cf6d`** — candidate `f6b1a602-...`, full seven-receipt set including the complete
  `TERMINAL_OUTPUT_LIVENESS` stall transition (643s, `woke_for=stalled`, escalation published) and
  the settled `FAILED_WORK_NO_REVIEW` proof. Exported to `.ai/package-b-final-head-receipts.txt`.

The delta between the two heads is `b954873e83` alone: it adds `launchStrategies` /
`nativeLaunchPossible` to the route capability and makes worker-start admission read the derived
contract. It does not touch gate fingerprinting, lease behaviour, intake, liveness classification or
advance eligibility, so the receipts for those subsystems at `8ede73cf6d` remain valid for the code
that produces them. I am stating that rather than claiming a full re-run I did not complete: the
stall proof alone needs eleven minutes of real silence, and the failing-builder round had not
settled when I tore down.

## Gates

Clean full suite, nothing else contending: **6630 files, 62,202 passed, 247 skipped, 0 failed**
(run at `8ede73cf6d`). Earlier runs showed 3-5 failures in
`remote-runtime-shared-control-connection`, `automation-change-publication` and
`terminal-output-frame-chunks-equivalence`; all three pass in isolation and were CPU contention from
my own concurrent suite and candidate runs, not regressions. At `b954873e83`: typecheck 0 errors,
oxlint clean, changed-code quality **0 new findings across 111 files** since `fecdf0bde885`,
max-lines ratchet OK, reliability gates 99, bundled skill guides OK, and the affected control-plane
and shared suites green.

Teardown: every candidate stopped, `/tmp/orca-cand-*` removed, all synthetic worktrees and repos
removed, zero dangling registrations, native Orca alive and unchanged at PID 8264 with 29 Runs.
