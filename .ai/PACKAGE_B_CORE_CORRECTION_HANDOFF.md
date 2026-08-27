# Package B consolidated core correction

## Durable identity

- Outcome Run: `run_940419794b63`
- Reuse this exact retained Opus terminal/session; do not create a replacement worker or Run.
- Reviewed Package B head: `b3c603b36100d4f0cf813371fc5bf779d3eed0a3`
- Required upstream base before final proof: `fecdf0bde8850b81403df4609fbc98d0e805f31f`
- This is one consolidated FIX_FIRST correction, not a new architecture lane.

## Scope

Correct all seven independently reviewed core defects in the smallest maintainable way:

1. **Certification event integrity.** Every certification evidence kind must come from a runtime-owned event source. A caller may request an operation but cannot declare successful evidence. Completion requires accepted terminal completion; recovery requires a real recovery transition; role execution requires that role/session to execute. Effective provider/model/reasoning identity must come from the actual provider/session/runtime receipt and must fail closed when unobservable. Add negative controls for fabricated evidence and requested-to-effective identity copying.

2. **Current SHA and runtime binding.** Worker-start route admission must reject certification evidence not bound to the current candidate commit SHA, current runtime version/build identity, exact route identity, and required role/session mode. Wrong-SHA or wrong-runtime evidence is immediately stale/fail. Add controls for SHA A to SHA B and runtime A to runtime B.

3. **Real incremental gate validity.** Fingerprint actual relevant file bytes plus gate configuration/version inputs, not paths. Each receipt declares its dependencies. A correction invalidates only gates whose dependency fingerprint changed. Byte-identical unaffected inputs may be reused across a Git SHA when all other invariants allow it; exact-head publication/review gates remain SHA-bound. Prove file X invalidates Gate X while Gate Y remains reusable, and same path/different contents invalidates.

4. **Validation mutation fence.** Orca-managed supervised mutation/execution paths must consult the active validation lease. An already-running builder cannot mutate the protected worktree during validation. Bind lease ownership to owner/Run/Task/Dispatch/worktree as appropriate; only the rightful owner may release it. Crash/expiry recovery must be deterministic and fail closed. Do not attempt global OS-write interception; preserve the approved separate-worktree-or-wait design.

5. **Terminal-output liveness.** Include authoritative terminal/session output-activity timestamps where available alongside process/session state, active tool call, provider exit, and runtime wait/tool state. Model heartbeats remain excluded. Prove output without a new hook is not stalled, followed by no authoritative activity beyond threshold becoming stalled.

6. **Operational atomic 2-5 outcome intake.** Expose the smallest production RPC/CLI operation accepting 2-5 Sol/DCS-supplied outcome manifests and semantic claims together. Atomically bind distinct Run/outcome identities, evaluate overlap before builders launch, reject/serialize dangerous overlap, allow safe independent outcomes, return one structured receipt, and be replay-idempotent. Unknown mutation outcome must never produce partial admission. Orca does not classify business issues. Include a real RPC-level proof, not only a pure-function test.

7. **Failed work never advances.** Lifecycle ordering must require accepted completion + succeeded outcome + completion gate PASS before next-phase eligibility. FAILED, REJECTED, BLOCKED, MISSING_RECEIPT, INVALID_CAPABILITY, and equivalent typed non-success states must settle/escalate without creating or launching a reviewer. Add negative controls proving zero review Task/Dispatch/session for a failed builder.

Also remove the literal NUL-source-file hazard in `outcome-identity.ts` if it remains in the corrected surface, preserving the intended domain separation without leaving the source classified as binary.

## Required reconciliation and proof

1. Fetch and reconcile non-destructively onto exact `origin/main` `fecdf0bde8850b81403df4609fbc98d0e805f31f`; preserve upstream fixes and do not rewrite history cosmetically.
2. Run focused bug-rejecting tests for all seven defects.
3. Run complete affected Package B suites and broader repository gates required by changed runtime surfaces.
4. Build a new isolated, hook-capable candidate from the new exact head without replacing or restarting JB's native Orca and without mutating native state.
5. Produce live receipts for: `CERTIFICATION_EVENT_INTEGRITY`, `SHA_RUNTIME_BINDING`, `INCREMENTAL_GATE_REUSE`, `VALIDATION_MUTATION_FENCE`, `TERMINAL_OUTPUT_LIVENESS`, `BATCH_2_TO_5_INTAKE`, and `FAILED_WORK_NO_REVIEW`.
6. Re-run the prior core smoke: durable wait, runtime liveness, stall, crash, automatic builder-to-reviewer, duplicate prevention, rejected completion, state isolation, no old Dev Orca dependency, and native compatibility.
7. Commit the correction and report exact base, exact final HEAD, worktree state, test counts, candidate identity, and bounded proof-artifact paths in exactly one `worker_done` for the new Task/Dispatch.

## Explicit exclusions

- Do not publish, package for release, push, open a PR, merge, deploy, or restart native Orca.
- Do not work on provider/harness compatibility: Opus identity, GLM PreTool, Gemini support, Grok harness, Fable identity, or Sol/Codex MCP startup.
- Do not work on `WORKER_UI_SETTLEMENT_STATE` or sidebar spinner appearance.
- Do not weaken hooks, security, validation, or historical audit records.
- Do not create another Package B Run, another architecture/research lane, or a replacement provider session.

## Completion threshold

If a genuine protected blocker is reached, send one typed escalation with exact evidence. Otherwise remain on this Task through implementation, correction, tests, isolated live proof, commit, and the single completion receipt. Do not stop between internal gates.
