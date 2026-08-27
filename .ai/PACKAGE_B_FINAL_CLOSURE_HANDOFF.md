# Package B final closure — one retained-Opus correction

## Immutable identity and authority

- Existing outcome Run: `run_940419794b63` — do not create another Run.
- Reviewed blocked head: `b954873e838366b275117d7cdc06f03cd9d8fb1f`.
- Freshly fetched upstream pin at dispatch: `origin/main = 249d93bc5d2fd3b04581aae9916afc84bc787c8b`.
- Current branch: `jb-workflow-control-plane-b`.
- Exact worktree: `/Users/prometheus/orca/workspaces/orca-jb/jb-workflow-control-plane-b`.
- Retained principal terminal: `term_b227bbdb-6fff-484b-819b-0780a7bd89a8`.
- Principal builder: the same retained Claude Code Opus session, exact requested model `opus[1m]`, highest available reasoning. You are the sole editor, stager, committer, and implementation authority.
- Control Room Sol coordinates only. Do not ask it or JB to make routine engineering choices.
- No push, PR, release, install, native-app restart, merge, or deploy during this Task. Publication follows only after exact-head live proof and a fresh Fable `SHIP` review.

Reconcile the branch non-destructively onto the pinned current `origin/main` before final proof. Preserve upstream fixes and inspect all newly added or materially changed files in this correction's semantic surfaces, not only textual conflicts. Do not rewrite history cosmetically.

## Exactly one required native Sonnet mapper

Immediately launch exactly one native in-session Sonnet helper. It is read-only and may only:

1. map every frozen blocker below to exact current-main files, symbols, authoritative writers/readers, production call sites, and existing/missing tests;
2. identify current-main overlap;
3. triage failed tests;
4. check that no acceptance surface is omitted.

The Sonnet helper must not edit, stage, commit, create a worktree, invoke Orca, contact JB, or create a sidebar worker. Record requested and effective helper identity/capability in the durable report. Independently verify every Sonnet finding before acting. Use no other helper/subagent for this implementation Task.

## Frozen scope — close only these loops

### 1. Runtime-owned completion and gate proof

The worker may submit intent, summary, believed changed files, and optional artifact paths only. Runtime must independently observe and bind actual final Git commit, clean/dirty state, Git-derived changed-file set, immutable runtime/build provenance, actual gate process command/exit, receipt/log digest, and exact Run/outcome/Task/Dispatch/worktree. A worker/caller may not declare PASS.

Known blocked-head gaming paths:

- `completion-receipt.ts` validates worker payload equality/booleans rather than Git/tree/runtime evidence.
- `lifecycle-reconciliation.ts` trusts worker `filesModified`; `lifecycle-advance.ts` can turn it into a receipt.
- `orchestration-gate-ops.ts` lets a caller choose SHA/cwd/files/gate/result without proving execution.
- certification proxies can misstate duplicate prevention, recovery, reviewer execution, effective identity, hook admission, or caller-declared FAIL/UNSUPPORTED.

Required negative: fabricated worker PASS, equal claimed SHAs, claimed clean tree, or PASS without a successful runtime-owned gate process must be rejected and create zero reviewer Task/Dispatch/session.

### 2. Immutable build provenance

Generate immutable build/package provenance containing source SHA, build ID, app/runtime version, dirty-build state, schema version, and useful timestamp. Runtime reads the embedded/generated record; it must not infer source identity from the checkout's mutable current HEAD after startup. Bind route certification and receipts to this provenance. Cover dev, packaged/native, remote/SSH, and folder-workspace behavior without pretending a non-Git folder has a commit.

Required negatives: build at A then checkout moves to B still reports A; evidence for build A is stale under build B; changing a non-entry runtime module changes build provenance; packaged runtime has usable immutable provenance.

### 3. Runtime-owned incremental gate dependencies

Define narrow gate-owned dependency/config manifests. Git/runtime, not worker/caller payloads, discovers actual change and dependency inputs. Receipts hash actual file bytes plus gate/config/command/tool/environment inputs where material, result, and log digest. Reuse across SHA is allowed only for byte-identical runtime-owned dependencies and policy-permitted gates. Publication/final-review gates remain exact-head bound.

Required negatives: same path/different bytes invalidates; unrelated file permits unrelated gate reuse; omitted changed dependency is still discovered and invalidated; empty/caller-crafted dependency set cannot mint reusable PASS.

### 4. Authoritative validation mutation fence

Lease binds worktree, Run, outcome, Task, Dispatch, owner, lease ID, expiry/recovery. Every Orca-managed supervised mutation path actually used here (hook/tool/custom-terminal/re-engagement as applicable) consults the fence. An already-running worker cannot perform a managed mutation during validation. Acquisition is serialized; only the rightful owner or deterministic expiry/crash recovery releases. Ownerless/wrong-owner release fails. Do not claim interception of arbitrary OS writes.

Required live proof: already-running worker → lease acquired → managed mutation blocked → rightful release → mutation succeeds; wrong owner release fails.

### 5. Recoverable phase-start crash state

Close `PLANNED → STARTING(owner/attempt/lease/deadline) → DISPATCHED → RUNNING → SETTLED`. A crash/lost response after persisted STARTING reconciles the exact original mutation or becomes typed retryable after bounded recovery. Never blindly replaces a worker and never strands STARTING. Errors must produce a typed blocker/wake rather than being logged and discarded.

Required negative: crash after STARTING persistence, restart, reconcile/retry exact phase, zero duplicate worker.

### 6. Exact-process terminal-output liveness

Terminal output counts only when bound to exact Dispatch, terminal, process/session incarnation, and a cursor/timestamp after that Dispatch began. Prior Dispatch, replaced process, old terminal incarnation, or another session cannot keep current work alive. Combine exact-process output with process/session status, hook/tool activity, provider exit, and current wait/tool state. No model heartbeat.

Required proof: stale process output does not prevent current silent/dead Dispatch becoming STALLED/CRASHED; current exact process output without hooks prevents a false stall, then silence crosses the threshold and stalls.

### 7. Atomic operational 2–5 outcome intake

One production RPC/CLI accepts 2–5 prepared manifests. Sol/DCS supplies identity, objective, target, semantic/overlap claims, dependency/serialization relationships, and route candidate order. Orca validates all before mutation, rejects contradictory/duplicate/cyclic relations, makes the admitted generation immutable, serializes conflicts, admits safe independent work concurrently, binds distinct authoritative outcome/Run identities, and prevents federated/custom starts from bypassing admission. One idempotency key; all-or-nothing; unknown-result recovery cannot partially duplicate.

Required live RPC proof: A and B independent concurrent; C explicitly blocked/serialized behind A; replay creates zero duplicate Runs/outcomes; federated direct-start bypass rejected; contradictory/cyclic batch rejects with zero partial admission.

### 8. One end-to-end route contract

Current native Orca launch truth already includes Opus, Sonnet, OpenCode/GLM-5.3, Gemini Flash, Grok, Fable, and Codex/Sol through its supported native strategies. Do not add provider adapters unless native current Orca truly lacks a route.

One authoritative derived contract must drive native discovery, certification admission, structured/custom-terminal start, retained re-engagement, PreTool, safe-launch, and automatic reviewer launch. Preserve exact identity/reasoning/worktree/Run/Task/Dispatch and protected-action boundaries. OpenCode's native plugin hook is not absence of hook support. Do not freeze old `AGENT_HOOK_TARGETS` or SCL literal allowlists as provider truth.

Known blocked-head gaps:

- `route-registry-discovery.ts` still derives hook support differently from `native-route-contract` and misclassifies OpenCode.
- automatic phase launch supports only structured preferences, not native custom-terminal attach strategies.
- provider-observed effective identity and persisted PreTool/safe-launch decisions lack complete production writers/readers.
- old SCL PreTool/safe-launch tables can contradict native Orca.

Resolve wrapper/tool version from the target runtime, pinned authoritative installation, or exact target worktree. Never use a stale coordinator checkout. Do not edit outside this exact worktree or create another implementation worktree. If a genuinely required end-to-end policy consumer has no versioned home in this repository and cannot consume the derived runtime contract without a second repository mutation, prove the exact ownership conflict and issue one typed escalation before any cross-repo edit.

Route smoke matrix: Opus, Sonnet, GLM-5.3, Gemini Flash, Grok, Fable, Sol/Codex. For each report native discovery, PreTool, safe-launch, requested/effective identity, role, fresh/retained, and typed result: PASS, BLOCKED_AUTH, BLOCKED_QUOTA, FAIL_PROVIDER_STARTUP, FAIL_IDENTITY, or TRULY_UNSUPPORTED. Fable must PASS before final review can launch.

### 9. Failed work never advances

Only accepted completion + succeeded outcome + runtime-owned completion PASS + required gate PASS makes next phase eligible. Failed/rejected/invalid/missing/dirty/stale/wrong-runtime/blocked/crashed work creates zero reviewer Task, Dispatch, or provider session and settles/escalates once in a typed state.

### 10. Narrow settled-worker UI projection

Close only the spinner defect. Accepted `worker_done` / settled Dispatch must stop the active spinner and show COMPLETED or IDLE/RETAINED as appropriate. Retained terminal availability is not active work. Preserve physical terminal/worktree linkage. Follow `AGENTS.md`, `docs/STYLEGUIDE.md`, existing tokens/components, and validate the exact Electron UI with Playwright CDP; no sidebar redesign.

### 11. Fresh exact-head certification

After code and current-main reconciliation: focused bug-rejecting controls; affected/full runtime suites; typechecks/lint/format/code-quality/build/package gates required by changed surfaces; builder adversarial review. Build one isolated hook-capable candidate from the final clean exact head with separate state/db/socket/ports/profile/workspace. It must not migrate/mutate native Orca `1.4.190` runtime `868298d7-29b6-413d-b374-507abfb6e019`, depend on the retired Dev profile, or create a permanent Electron-dev dependency.

Live-prove all corrected surfaces plus prior smoke: durable wait, liveness, stall, crash, automatic builder→reviewer, duplicate prevention, rejected completion, failed-no-review, state isolation, no old Dev dependency, native/package compatibility. Persist bounded receipts bound to exact final SHA and immutable candidate provenance, then tear the candidate down only after receipts exist. Do not claim stale receipts from b954 or earlier heads.

## Completion and handoff

Stay on this one Task through implementation, current-main reconciliation, tests, live certification, candidate teardown, commit, and builder adversarial review. Do not stop between internal gates. Do not push or open a PR.

Return exactly one `worker_done` naming this Task/Dispatch, exact base/upstream pin/final SHA, ancestry, clean state, Sonnet helper requested/effective identity and verified map path, files, tests/counts, negative controls, candidate identity/provenance, live receipts, route matrix, batch proof, UI proof, native Orca unchanged, rollback point, and every unproven claim. Builder prose is not acceptance; the Control Room will independently verify and then automatically launch fresh Fable review.
