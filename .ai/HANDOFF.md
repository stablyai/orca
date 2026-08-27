# PACKAGE B — ORCA CONTROL PLANE

## Role and outcome

You are the sole implementation builder for JB's approved Package B. Work only in this dedicated Orca source worktree. The Control Room owns architecture, acceptance, and final review; you own implementation and builder-side proof. Do not merge, release, install over the running Orca app, mutate historical orchestration data, or touch SCL/DCS/Reality repositories.

Outcome: make Orca's model routing and Run/Task/Dispatch lifecycle deterministic enough that JB can submit 2–5 independent business outcomes and return only for a protected decision or reviewed candidate.

Base and rollback point: `026389a3bc03da03ca2d65295e805493712b0774` (current fetched upstream `origin/main` at admission). Installed runtime is Orca `1.4.188`; its upstream tag `v1.4.188` peels to `f32ce859...`. Preserve wire/database compatibility with existing historical Runs, Tasks, Dispatches, and Deliveries. Never rewrite or delete them.

## Before editing

1. Prove `pwd`, branch, base, clean state, remotes, package/runtime version, and current fetched upstream main.
2. Read all repo `AGENTS.md` / `CLAUDE.md` instructions that govern touched files.
3. Map each acceptance item below to the existing authoritative writer, reader/consumer, tests, and final allowed files. Reuse/extend current orchestration contracts; do not build a second orchestrator.
4. Inspect the current coordinator runtime contract, lifecycle reconciliation, preamble, provider registry/liveness, CLI orchestration handlers/specs, persistence schema, and tests before proposing the patch.
5. Record any true scope contradiction as one bounded `ask`; otherwise proceed autonomously.

## Allowed source scope

Use the smallest subset necessary from:

- `src/main/runtime/orchestration/**`
- `src/main/runtime/rpc/methods/orchestration-*.ts` and colocated tests
- `src/cli/handlers/orchestration/**`
- `src/cli/specs/orchestration*.ts` and colocated tests
- `src/main/ipc/pty/provider/**` and colocated tests
- existing shared provider/session option catalog modules and colocated tests
- version-matched orchestration skill/CLI documentation and generated copies only when the generator contract requires them

Do not edit renderer/UI, mobile, release/version files, unrelated refactors, the installed Orca application, SCL product code, DCS, or Reality code. If a required authoritative file is outside this list, stop with a precise `ask` naming the criterion, file, and why no allowed reader/writer exists.

## Required product contract

Implement the smallest coherent typed substrate that closes these loops. Existing behavior counts only when current code plus a regression test proves it.

### B1 — authoritative role/model certification

- One typed registry/contract must be authoritative for safe launch admission, runtime provider/model identity, retained-session eligibility, reviewer eligibility, and fallback selection.
- It must represent requested and effective provider/model/reasoning, role capabilities (builder/reviewer), fresh and retained/re-engagement capability, certification state (`PASS`, `FAIL`, `STALE`, `UNTESTED` or equivalently closed enum), evidence timestamp/version/SHA, and failure reason.
- Automatic fallback may select only a current `PASS` route for the requested role/capability. Fable is reviewer-only. Local Qwen is excluded from Orca worker routing. No hard-coded Opus -> Flash -> GLM chain.
- Identity mismatch, stale certification, unsupported retention, or wrong reasoning fails closed with a bounded structured error.
- Preserve compatibility with existing provider/session catalogs. Do not claim a live route PASS from mocked tests.

### B2 — one outcome, one durable Run

- Add/extend a durable outcome identity and admission contract so a new issue cannot silently inherit an unrelated historical Run.
- Support intake of 2–5 independent outcomes, each independently DCS/admission-addressable later, with semantic-overlap and resource-collision decisions represented explicitly.
- Delivery/Task/Dispatch resolution must remain outcome-matched. Existing historical rows remain readable and unchanged; any compatibility fallback must fail closed for new writes.

### B3/B4 — runtime-owned waiting and liveness

- Coordinator subscribes once and yields. Runtime wakes it only for: `WORKER_DONE`, `QUESTION`, `ESCALATION`, `STALLED`, `CRASHED`, `REVIEW_COMPLETE`, `CI_BLOCKER` (typed equivalents acceptable).
- No 25/30-second coordinator continuation loop. A timeout with no event is not a wake event.
- Runtime, not the model, owns liveness from process/session state, last output/activity, active tool call, an approved blocking wait, provider exit, and terminal state.
- Remove the five-minute model-generated heartbeat requirement from worker preamble/protocol. Define the authoritative clock, persisted marker, writer, consumer, expiry, re-arm behavior, idempotency, concurrency/serialization, and terminal resolver.
- Preserve current `check`/Delivery behavior for compatibility while adding a non-polling subscription/wakeup path.

### B5 — compressed worker protocol

- Bind Task ID, Dispatch ID, coordinator, capability, Run/outcome identity in runtime-generated context.
- Expose typed worker operations equivalent to `worker_done`, `ask`, and `escalate`; the model must not construct fragile Orca CLI command lines.
- Fresh workers receive a concise static bootstrap plus actual task. Retained workers receive only a small dispatch delta plus actual task, not the full lifecycle manual again.

### B6 — authoritative completion receipt

- Before accepting `WORKER_DONE`, software validates exact final Git HEAD, claimed commit SHA, test/preflight receipt SHA, receipt PASS/FAIL, worktree cleanliness, and expected Task/Dispatch/Run/outcome identity.
- A PASS receipt for an older SHA is rejected. Return the exact missing/stale gate in a typed error.
- Account for local/folder/SSH execution placement without running arbitrary untrusted shell text. Define failure recovery and retry idempotency.

### B7 — builder to reviewer automation

- A validated builder completion can deterministically advance to an independently configured reviewer Task/Dispatch using only a currently certified reviewer route.
- `FIX_FIRST` routes one consolidated correction to the same retained builder when its route/session remains certified and eligible; final review binds exact final SHA.
- No hidden fan-out and no auto-merge/deploy. If no certified role route exists, emit the protected blocker.

### B8/B9 — incremental gate validity and process safety

- Gate receipts bind deterministic inputs (at minimum final SHA, relevant file/input hashes, policy/gate version, command identity, and result). Reuse is permitted only when the receipt proves unaffected inputs; invalidated gates rerun. High-risk policy can require the full gate set.
- Introduce/extend a runtime-owned validation lease so an active test/preflight cannot be contaminated by source mutation in the same worktree. Baseline reproduction must use a separate worktree/process or wait for lease completion.
- Define lock/serialization, ownership, idempotency key, retries, crash recovery, and stale lease expiry.

### B10 — machine-actionable recovery

- Expose one bounded structured state query for an exact outcome/Run/Task/Dispatch/session: identity, lifecycle, last meaningful event, liveness classification, route/certification, completion-gate status, and next legal actions.
- Recovery must not require full worker-list dumps, transcript archaeology, repeated status/list/show calls, or shell-syntax discovery.

## State-machine and compatibility requirements

For every new state/event/hook, document in code/tests: trigger, immediate state, authoritative writer/clock, next state, re-arm behavior, terminal resolver, transaction boundary, serialization/lock, idempotency scope, retry/concurrency behavior, and crash/failure recovery.

Use migrations or additive persistence only if necessary. Existing databases and historical records must remain readable. Do not make destructive schema changes. Preserve current public RPC/CLI wire contracts unless adding backward-compatible typed fields/commands.

## Required proof

- Focused regression tests for every implemented criterion, including negative controls that fail when the guarded invariant is deliberately removed or violated.
- At minimum test: stale/failed route excluded from fallback; Fable builder rejection; Qwen worker-route rejection; requested/effective mismatch; unrelated Run reuse rejection; duplicate retry idempotency; empty wait does not wake coordinator; runtime stall/crash wake; no model heartbeat in preamble; stale-SHA completion rejection; dirty worktree rejection; wrong Task/Dispatch/outcome rejection; retained delta compression; reviewer only after validated completion; FIX_FIRST same-builder targeting; unaffected receipt reuse and affected receipt invalidation; active validation lease blocks mutation; exact bounded state recovery.
- Run relevant existing orchestration/provider/CLI suites, Node and CLI typechecks, and `pnpm run check:code-quality:changed` (or the repo's current exact equivalents). Do not suppress max-lines, lint, or safety rules.
- Add a builder-side adversarial review of the final diff. Clearly separate unit/integration proof from real installed-runtime/provider certification still pending.
- Commit durable implementation to the owned branch with explicit paths only. Do not push or open a PR until the Control Room independently reviews the local exact SHA and authorizes the next gate.

## Completion receipt

Return exactly one terminal `worker_done` for this Task/Dispatch. Include: outcome, Task/Dispatch IDs, exact branch, base SHA, final commit SHA, clean/dirty state, files changed, tests with results, negative-control evidence, compatibility evidence, unresolved blockers, and explicit claims that were not live-certified. Builder prose alone is not acceptance; the Control Room will independently verify the exact SHA.

## CORRECTION 1 — MODEL-AGNOSTIC MULTI-MODEL CONTROL PLANE

This correction supersedes any fixed primary-builder, provider-preference, fallback-order, generic-model-identity, or permanent ranking assumption. It does not remove or narrow B1–B10 above.

### Identity and registry authority

- Model identity is data, never branching logic. No default Opus implementation path and no hard-coded Opus -> Flash -> GLM fallback.
- Discover the existing authoritative provider/session/model ownership before finalizing the registry. Safe-launch admission, PreTool grammar/policy, reviewer routing, retained-session logic, provider preflight, and certification drift checks must consume one authoritative registry or a deterministically generated artifact from it.
- The typed registry must be open to future certified models and carry, where the current architecture can prove it: exact model/version ID, provider, harness, eligible roles and task capabilities, supported reasoning modes, fresh-launch/retained/review/UI/long-build certifications, context limit, availability, quota state, cost/subscription class as a runtime constraint, known constraints, certification time/version/evidence identity, and current staleness.
- Unknown/unobservable facts remain explicit `UNKNOWN`; never infer quota, reset time, availability, or effective model identity.
- A provider/model cannot be launcher-supported and hook-rejected. Add a drift/consistency test that fails before real work.

### Role-based selection and fallback

- DCS will later supply task classification, semantic surface, risk, Reality needs, and invariants. Sol supplies required execution characteristics and selects from currently certified routes. Orca validates and launches that explicit choice; Orca does not make provider-loyal engineering judgments.
- Support open-ended task capabilities including bounded implementation, deep architecture, large multi-file build, UI implementation, fast fix, heavy review, adversarial review, overflow build, and future typed capabilities without embedding rankings.
- Fallback is constrained to a current `PASS` route for the same required role/capabilities. Classify failures as control-plane, provider unavailable, quota, model execution, or task failure. Repair safe control-plane faults first; never substitute a materially ineligible route just to continue.
- Multiple different certified models may run concurrently for independent outcomes when semantic and machine-resource admission permits it. There is no global primary builder.
- Sol remains principal/judgment layer and may be a fresh independent reviewer. It is not a default product builder after another provider fails.
- Local Qwen remains outside normal Orca worker routing: Reality broker/deterministic local caller -> Ollama -> `qwen3.5:35b-a3b`.

### First-class current certification targets

Discover exact installed/provider truth; do not encode the prompt's candidate role descriptions as certified facts.

- Claude Opus 5 through the current Claude Code harness. A generic `opus` alias is not identity proof unless the provider receipt resolves exact Opus 5.
- GLM-5.3 through the exact current OpenCode/GLM harness. Treat as a first-class builder candidate. Separate control-plane failure, provider/model failure, and usage limit. Record quota as `UNKNOWN` unless observed; the historical approximately five-hour large-work constraint is scheduling context, not certification or ranking.
- Gemini 3.7 Flash through the installed Gemini CLI mapping where actually available. An alias such as `gemini-flash-latest` must not silently count as exact identity proof.
- Grok 4.6 through the actual available Orca/xAI harness. Discover whether the generic provider abstraction already supports it; if not, implement only the smallest generic adapter extension. Do not create a Grok-only control plane. Candidate certification covers a harmless bounded build and heavy review, exact effective identity, reasoning if configurable, completion, retained re-engagement if supported, and duplicate prevention.
- Fable remains reviewer-oriented unless runtime evidence certifies expansion.
- Sol/Codex is a principal and independent reviewer target where certified.

Do not claim any route PASS from source tests alone. Real harmless fresh/retained role certification is a post-build runtime gate and must remain `UNTESTED`/`FAIL`/`UNSUPPORTED` until that evidence exists.

### Certification evidence contract

For every intended model, support durable evidence for:

1. fresh launch;
2. requested and effective exact model identity;
3. requested and effective reasoning mode;
4. PreTool acceptance;
5. safe-launch acceptance;
6. exact Task/Dispatch and worktree binding;
7. completion receipt;
8. retained re-engagement;
9. duplicate prevention;
10. failure recovery;
11. builder role and reviewer role independently.

Expose per-route outcomes as `PASS`, `FAIL`, or `UNSUPPORTED`, SHA/version/timestamp-bound, with stale evidence automatically excluded from routing.

### Provider readiness

Admission should carry observable route availability, authentication readiness without secret exposure, provider status, quota/window/reset data where the harness exposes it, and model availability. Exact unavailable telemetry is `UNKNOWN`. Subscription/cost tier is runtime scheduling data, never architecture or intelligence classification.

### SCL model-performance ledger

Create or reuse an additive durable, scrubbed performance ledger under Orca's orchestration persistence ownership. Track actual SCL outcomes without customer evidence or PII: exact model/version, role, task classification, first-pass result, correction rounds, reviewer/escaped defects, wall-clock time, tool calls, context/provider usage when available, provider-limit interruption, and rescue model. Existing historical evidence is imported only through an explicit evidence-backed path; do not convert prompt statements or public benchmarks into rankings. Define retention, idempotency, and provenance.

### Additional proof

- Registry is order-independent/model-agnostic; permuting rows does not change role eligibility.
- No code path chooses Opus, Flash, GLM, Grok, Fable, or Sol merely by complexity or failure position.
- Unsupported/unverified Grok 4.6, GLM-5.3, Gemini 3.7 Flash, Opus 5, Fable, or Sol routes fail closed without being demoted or ranked.
- Exact alias/effective identity mismatch rejects certification.
- Quota `UNKNOWN` remains schedulable only under explicit policy and is never fabricated as available.
- The final builder receipt must name the durable registry and ledger locations and separate implemented control-plane support from each live certification still pending.
