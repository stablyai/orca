# Orca Orchestration Implementation Checklist

This is the durable implementation ledger for the orchestration primitives proposal. Update it in
the same change that implements, removes, or materially revises an item. The design source is
`docs/orchestration-primitives.html`; keep it synchronized with this checklist.

## How to use this file

- Check an item only after its implementation and proportionate tests are complete.
- If an item changes meaning, edit the checklist and add a dated decision-log entry explaining why.
- After every implementation session, append a progress-log entry with files, tests, findings, and
  the next concrete step.
- Do not mark a phase complete while any acceptance test in that phase remains open.
- Preserve the non-goals. A new subsystem requires separate evidence and a separate proposal.

Status meanings:

- `[ ]` not started or not proven
- `[x]` implemented and verified
- `DEFERRED` deliberately outside the current implementation sequence

## Current summary

- [x] Fresh primitive-oriented design written and repeatedly reviewed.
- [x] Product UI changes explicitly excluded.
- [x] Current orchestration skill now teaches setup-run for new worktrees, batch processing,
      `agentTerminalHandle` preference, and the custom-argv setup-policy limitation.
- [x] Phase 0 command/skill compatibility work complete.
- [x] Phase 1 local Run, mailbox, lifecycle, and idempotency primitives complete.
- [x] Phase 2 same-server composed worker lifecycle complete.
- [x] Phase 3 connected-server federation complete.
- [x] Revalidate Phase 3 after the 2026-07-24 post-rebase dogfood exposed a renderer-adoption
      process-identity regression.
- [x] Phase 4 explicitly deferred because its exact-source prerequisite does not exist.

## Scope invariants

- [x] Agents choose decomposition, topology, placement, parallelism, and recovery strategy.
- [x] Low-level worktree, terminal, setup, and handoff commands remain independently usable.
- [x] Every composed mutation with external effects returns explicit effects and an honest outcome;
      control-plane-only mutations return their exact resource receipt.
- [x] Worker assertions remain labeled as worker reports, not Orca-verified correctness.
- [x] Silence alone never proves worker death or triggers replacement.
- [x] Multi-server Runs use one authoritative Run home and connected worker servers.
- [x] Runtime/server/host identity mechanics remain hidden from ordinary agent commands.

Explicit non-goals:

- [x] No product dashboard, Run UI, badges, or coordinator chat UI.
- [x] No scheduler, automatic placement, capacity allocator, fairness, or priority aging.
- [x] No automatic retry or replacement based on silence.
- [x] No commit, branch, merge, integration, or target-ref tracking.
- [x] No filesystem read-only/writer enforcement.
- [x] No generalized ACL, organization, role, or worker-profile system.
- [x] No replicated Run database, leader election, or automatic Run-home failover.
- [x] No dead-letter/poison-message workflow.
- [x] No universal provider-session or transcript framework.

## Phase 0 — Vocabulary and current-agent ergonomics

### Command compatibility

- [x] Remove or rename the existing scheduler-like `orca orchestration run --spec` before shipping
      lightweight `run-*` commands.
- [x] Publish the canonical command map in CLI help.
- [x] Define aliases or explicit deprecations for any renamed current command.
- [x] Keep current flat task commands unless a separately justified CLI migration changes them.
- [x] Require explicit destructive reset scope; bare reset must not imply reset-all.

### Skill and recipes

- [x] Teach that `check --wait` returns a message batch, not one message.
- [x] Teach processing every returned message and waiting until expected Dispatches settle.
- [x] Document crash-safe explicit acknowledgment and redelivery of an unacknowledged batch.
- [x] Prefer `agentTerminalHandle`, then legacy `startupTerminal.handle`, then exact terminal-list
      resolution.
- [x] Pass `--setup run` for new worktrees by default.
- [x] State a concrete reason before using `--setup skip` or `--setup inherit`.
- [x] Preserve `start-immediately` as the normal setup/agent startup policy.
- [x] Warn that the two-step custom-argv launch cannot preserve explicit `wait-for-setup`.
- [x] Add executable current-version recipes for local fan-out, new worktrees, completion/failure,
      questions, timeout recovery, and restart limitations.
- [x] Ensure installed, bundled, repository, and generated orchestration skill copies stay in sync.

### Phase 0 acceptance

- [x] An agent reading only CLI help and the skill can select current versus new worktree correctly.
- [x] The agent starts all independent workers before blocking.
- [x] The agent cannot mistake the old scheduler Run for a lightweight namespace Run.
- [x] Recipes contain only commands supported by the matching shipped CLI version.

## Phase 1 — Run, mailbox, lifecycle, and durable mutation receipts

### Lightweight Run

- [x] Add a Run table with stable Run ID, objective, created/updated timestamps, and home database.
- [x] Add mandatory Run association to new Tasks, Dispatches, Messages, deliveries, and questions.
- [x] Migrate pre-Run orchestration rows into one unbound, inspect-only legacy Run.
- [x] Keep old scheduler-run storage distinct from lightweight Runs.
- [x] Implement `run-create`, `run-use`, `run-current`, `run-list`, and `run-show`.
- [x] Bind a coordinator pane explicitly; never infer a Run from a worktree or sole candidate.
- [x] Store one active mailbox consumer generation per Run.
- [x] Rebinding fences the old consumer and cancels its active waiter.
- [x] Do not implement Run archive/delete in V1.

### Logical routing and prompt safety

- [x] Add stable `run:<id>` and exact `dispatch:<id>` message recipients.
- [x] Do not add a task-recipient retargeting rule in V1.
- [x] Make send, ask, reply, completion, heartbeat, and runtime notices inbox-only.
- [x] Ensure only explicit dispatch injection and terminal-send operations can modify terminal input.
- [x] Define send success as durable acceptance, not observation or action.
- [x] Rename or remove `check --inject` if its name implies remote delivery.
- [x] Reject explicit Run/recipient targets from federated workers when the only valid destination is
      their authenticated Run home.

### Crash-safe inbox consumption

- [x] Add one FIFO mailbox sequence.
- [x] Bound each actionable delivery to 50 messages.
- [x] Allow one outstanding Delivery and one active actionable waiter per Run mailbox.
- [x] Return the identical Delivery ID and batch until acknowledgment.
- [x] Implement whole-batch idempotent acknowledgment.
- [x] Bind Delivery acknowledgment to the current consumer generation.
- [x] Implement atomic `ack -> check -> register waiter`.
- [x] Keep peek/all/history modes read-only.
- [x] Treat type filters as wake predicates only; return the oldest full actionable batch.
- [x] Return typed timeout, cancelled, connection-lost, waiter-exists, stale-delivery, and
      consumer-fenced outcomes.
- [x] Preserve unacknowledged mail across client and Orca process restart.

### Truthful lifecycle

- [x] Require `outcome=succeeded|failed` on terminal worker reports.
- [x] Map authenticated succeeded reports to Dispatch succeeded and Task completed.
- [x] Map authenticated failed reports to Dispatch failed and Task failed.
- [x] Persist stale/foreign reports as history without lifecycle mutation.
- [x] Reject malformed lifecycle transitions with typed missing/invalid fields.
- [x] Label result provenance as `worker_report`.
- [x] Apply every terminal transition as one transactional compare-and-set.
- [x] First committed completion, stop fence, or abandon wins.
- [x] Make duplicate identical completion idempotent.

### Questions

- [x] Model a question as durable message/thread state, not a task gate.
- [x] Default ask from an active Dispatch to its owning Run mailbox.
- [x] Record one idempotent first answer from the current Run consumer generation.
- [x] Reject conflicting later answers.
- [x] Resume by original message ID after timeout or disconnect.
- [x] Recover a lost ask-acceptance response through the same mutation retry receipt.
- [x] Close pending questions when their Dispatch stops or is abandoned.
- [x] Wake closed question waits with `dispatch_inactive`.

### Narrow pane authority

- [x] Mint an unforgeable per-Dispatch capability at lifecycle injection.
- [x] Carry the capability outside user-controlled request parameters on native, WSL, and SSH CLI
      bridges.
- [x] Persist only its verifier or secure-store reference.
- [x] Verify capability, exact managed pane, Dispatch ID, and process incarnation for lifecycle calls.
- [x] Revoke/fence the capability on stop, abandon, or replacement.
- [x] Do not generalize this into user/role access control.

### Durable mutation ledger

- [x] Let clients retain/reuse one opaque retry request ID after unknown acceptance.
- [x] Before effects, persist authenticated caller/peer, request ID, canonical payload hash,
      operation state, and receipt.
- [x] Join concurrent identical mutations or return the recorded result.
- [x] Return `request_mismatch` for the same request ID with a changed payload.
- [x] Cover Run/Task creation, send, ask, reply, acknowledgment, start, stop, and abandon.
- [x] Persist dedupe receipts across Orca restart.

### Phase 1 acceptance

- [x] Two Runs on the same runtime never mix tasks or mail.
- [x] An old coordinator cannot acknowledge or reply after `run-use` fences it.
- [x] A returned but unacknowledged batch is replayed after client/runtime restart.
- [x] Success, failure, stale completion, malformed completion, and duplicate completion tests pass.
- [x] Ask timeout/resume, same reply replay, conflicting reply, and stopped-Dispatch tests pass.
- [x] A forged pane/handle field cannot mutate lifecycle state.

## Phase 2 — Same-server composed worker lifecycle

### Command grammar and topology

- [x] Implement `worker-start`, `worker-show`, `worker-read`, `worker-stop`, and
      `worker-abandon` for workers owned by the Run home.
- [x] Current worktree creates one fresh agent terminal unless `--terminal` is explicit.
- [x] Named existing worktree creates one fresh agent terminal unless reuse is explicit.
- [x] Current/existing worktrees do not rerun creation-time setup or configured tabs.
- [x] New child worktree uses agent-first creation and reuses its returned agent terminal.
- [x] New top-level worktree uses agent-first creation with independent Orca lineage.
- [x] Reject child/top-level creation for folder projects before effects; use current/existing folder
      workspaces instead.
- [x] Pass the supported exact repo, base, lineage, display/comment metadata, and setup options to
      the existing worktree primitive rather than duplicating policy. `--on` owns connected-server
      placement; project/host convenience selection remains on low-level `worktree create`.
- [x] Require a configured agent launcher before any mutation.
- [x] Reject selector/option conflicts before effects for current/existing worktrees.

### Setup and startup

- [x] Omitted setup on a new worktree resolves to `run` for orchestration starts.
- [x] No configured setup hook resolves to `not_configured`, not failure.
- [x] Preserve repository `setupAgentStartupPolicy`.
- [x] Default `start-immediately` launches setup and agent side by side.
- [x] Under `start-immediately`, setup outcome never gates Dispatch readiness regardless of when
      it is observed.
- [x] The return receipt contains the latest setup state.
- [x] Only post-return setup state changes emit a typed setup notice.
- [x] Setup failure never automatically stops or fails an already-ready worker.
- [x] Explicit `wait-for-setup` completes setup successfully before agent launch and task injection.
- [x] Under `wait-for-setup`, setup failure produces start failure before task delivery.
- [x] Custom-argv two-step launch is rejected or clearly unsupported under `wait-for-setup`.

### Start operation and receipts

- [x] In one transaction, create a starting Dispatch, move the Task, and record the mutation request.
- [x] Persist the accepted Dispatch ID in a pending start receipt so restart recovery returns an
      exact `worker-show` command.
- [x] Persist before/after stage receipts around irreversible effects.
- [x] Return only `ready`, `failed`, or `outcome_unknown`.
- [x] Define ready as TUI idle, durable Dispatch attachment, and accepted lifecycle/task input.
- [x] Echo effective timeout, setup startup policy, defaults, and resolution sources.
- [x] Enumerate every effect: worktree, setup, agent terminal, setup terminal, each configured
      terminal pane, and dispatch input; include exact tab/leaf identity when available.
- [x] Tag every terminal effect with role and created/reused action.
- [x] Report setup as running only after its exact PTY spawn receipt is durable.
- [x] List every residual resource on failure or unknown outcome.
- [x] Never claim an effect was created before it exists.
- [x] Do not add a background provisioning executor; intentionally launched setup may continue as
      its receipt states.

### Dispatch and Task state machine

- [x] Implement starting, ready, start-unknown, failed, succeeded, stopping, stop-unknown, stopped,
      and abandoned Dispatch states.
- [x] Block the Task while start/stop outcome remains unknown.
- [x] Allow semantic `--retry-of` only from explicit failed, stopped, abandoned, or proven no-effect
      states.
- [x] Require the replacement to repeat its intended placement and agent/terminal choice; do not
      silently inherit a prior attempt's topology.
- [x] Reject unsafe retry without mutation.
- [x] Completed Tasks require a follow-up Task rather than retry.

### Show, read, stop, and abandon

- [x] Route operations by Dispatch ID after start; do not require resource IDs again.
- [x] Implement V1 `worker-read` as a thin route to bounded terminal-read.
- [x] Preserve cursor, limit, terminal status, and limited/truncated fields.
- [x] Stop fences lifecycle and blocks the Task in one home-side compare-and-set.
- [x] Stop affects only the supervised agent terminal/process.
- [x] Never delete the worktree, setup terminal, configured tabs, or unrelated processes.
- [x] Return stopped, already-settled, failed, and stop-unknown receipts truthfully.
- [x] Abandon performs no remote/process action, retains possibly-live resources, and enables a
      warned replacement.

### Same-server recovery tests

- [x] Current, existing, child, top-level, explicit-terminal, and configured-tab starts pass.
- [x] Setup run/skip/inherit and start-immediately/wait-for-setup combinations pass.
- [x] Trust/update prompt, setup failure, terminal failure, and task-input failure receipts pass.
- [x] Crash before effect, after possible effect/before receipt, and after durable receipt are
      distinguishable as failed/no-residual, outcome-unknown, and failed-with-residual respectively.
- [x] Stop/completion races preserve the first committed terminal transition.
- [x] Restart never adopts a same-looking pane or process incarnation.

## Phase 3 — Connected Orca server federation

### Placement and identity

- [x] Add worker-only `--on <saved-environment>` without changing global `--environment` meaning.
- [x] Default worker placement to the Run home.
- [x] Require `--on` for remote existing worktree/terminal selectors in V1.
- [x] Resolve remote resources through explicit read-only discovery; never guess by name/path.
- [x] Return `server_required`, `worktree_not_found_on_server`, and
      `terminal_worktree_mismatch` before related worker effects; treat a mismatched remote
      Dispatch/home receipt as `resource_server_mismatch` and never adopt it.
- [x] Pin each remote Dispatch to the authenticated worker-server public-key fingerprint.
- [x] Store runtime ID only as a process epoch, never durable server identity.
- [x] Return `peer_changed` with no effect if a saved environment is re-paired to a different server.
- [x] Preserve a routing tombstone when an environment with nonterminal Dispatches is removed.

### Remote Dispatch attachment

- [x] Persist a narrow attachment on the worker server before task input.
- [x] Store home peer identity, Dispatch capability verifier, stable pane/process incarnation,
      resource receipts, protocol version, and relay cursors.
- [x] Do not copy the Run DAG/database to the worker server.
- [x] Protect attachment credentials/database/WAL/SHM as current-user-only on macOS, Linux, and
      Windows.

### Bidirectional relay

- [x] Use the existing authenticated saved-environment connection; require no public callback or
      reciprocal pairing.
- [x] Run a Run-home subscription/pull service for active remote Dispatches.
- [x] Persist worker-to-home lifecycle/questions until home import acknowledgment.
- [x] Persist home-to-worker replies/control mail until worker import acknowledgment.
- [x] Key relay items by pinned peer, Dispatch ID, direction, monotonic sequence, and a
      128-bit-or-stronger message ID.
- [x] Import only contiguous source sequences; buffer/reject gaps.
- [x] Acknowledge only the highest contiguous committed sequence.
- [x] Assign ordinary Run-mailbox order only at home import.
- [x] Apply lifecycle transition and message import in one transaction before acknowledgment.
- [x] Enforce per-message and per-Dispatch count/byte quotas.
- [x] Coalesce heartbeats and reserve room for one terminal lifecycle report.
- [x] Return `relay_quota_exceeded`; do not add a dead-letter system.

### Federated control and recovery

- [x] Route show/read/stop/retry by Dispatch receipt; agents do not repeat `--on`.
- [x] Forward the same application retry request ID across home and worker server.
- [x] Return typed unknown outcome with last durable stage and exact next commands.
- [x] Reconcile a lost federated stop response from a later authoritative stopped receipt.
- [x] Treat abandonment of a superseded Dispatch as a no-op for the replacement Task.
- [x] Preserve and relay post-return federated setup evidence without changing worker lifecycle.
- [x] Recreate active relay subscriptions after Run-home restart.
- [x] Preserve worker attachment and relay state after worker-server restart.
- [x] Report running only when pane and process incarnation match after restart.
- [x] One disconnected worker server must not block local or other-server inbox delivery.
- [x] No automatic worker replacement on disconnect or silence.

### Capability negotiation

- [x] Advertise one aggregate `orchestrationFederationV1` control-plane capability.
- [x] Pin peer fingerprint and protocol version in the durable operation record.
- [x] Revalidate them inside the worker-side mutation, not only in a preflight probe.
- [x] Return `capability_unsupported` before Dispatch/resource/prompt effects.
- [x] Keep host/Git/setup validation inside existing primitives rather than a generalized capability
      matrix.

### Federation scenario matrix

- [x] Post-rebase physical Mac Run home -> Windows worker preserves exact process identity through
      renderer adoption, routed read, heartbeat, question/reply, completion, and stop.
- [x] Mac Run home -> Windows worker: start, completion, failure, question/reply, read, and stop.
- [x] Windows Run home -> Mac worker: the same flows through a saved Mac pairing.
- [x] Native, WSL, SSH, and relay-backed execution-host paths preserve ownership and CLI capability.
- [x] Run home restarts alone; worker server restarts alone; both restart.
- [x] Disconnect before send proves no effect.
- [x] Disconnect after possible acceptance returns unknown and deduplicates exact retry.
- [x] Duplicate and reordered relay frames/acknowledgments converge without loss or duplication.
- [x] Re-pair/key change cannot retarget an active Dispatch.
- [x] Same-looking handles/resources on two servers never cross-route.
- [x] Mixed server versions fail before effects.
- [x] Windows PowerShell quoting, Windows paths, WSL environment propagation, and SSH bridge
      allowlists pass.

## Phase 4 — Optional structured output adapter (deferred)

- [x] DEFERRED until Orca exposes an exact terminal-to-provider-session association.
- [x] Keep terminal-read as the V1 worker-read baseline.
- [x] DEFERRED: add only provider-specific readers after a proven exact source identity exists.
- [x] DEFERRED design constraint: never guess the latest session by current working directory.
- [x] DEFERRED design constraint: pin the selected source for the full cursor chain.
- [x] DEFERRED design constraint: preserve raw/provider-native entries and parsing warnings.
- [x] DEFERRED design constraint: label terminal fallback and its reason explicitly.
- [x] Do not add resume, live-stream control, session exclusivity, or a universal transcript ontology.

## Cross-cutting quality gates

### Persistence and transactions

- [x] Define process-crash durability separately from sudden-power-loss durability.
- [x] Keep SQLite WAL + `synchronous=NORMAL` for the documented process-crash guarantee; require a
      separate policy change before promising sudden-power-loss durability.
- [x] Keep lifecycle import, terminal transitions, and acknowledgment transaction boundaries explicit.
- [x] Exercise migrations from existing task/message/dispatch/scheduler-run data.

### Cross-platform

- [x] Native macOS, Linux, and Windows tests cover each new CLI/RPC contract.
- [x] WSL and SSH host identity/capability state is scoped to the actual execution host.
- [x] Paths use platform utilities; examples are PowerShell/cmd/POSIX safe.
- [x] Named-pipe, Unix-socket, WebSocket, WSL, and SSH bridges carry Dispatch capabilities safely.

### Documentation

- [x] CLI help owns exact flags, selectors, defaults, outcome fields, and exit-code behavior; typed
      RPC errors remain the machine-readable error contract.
- [x] The skill owns short decision recipes and common misuses, not protocol internals.
- [x] Every shipped phase updates this checklist and adds a progress-log entry.
- [x] The ignored HTML proposal and this tracked checklist remain semantically synchronized.

## Findings and decision log

### 2026-07-22 — Phase 2 closure without option-surface creep

- `worker-start` passes exact repository, base, child/top-level lineage, display/comment metadata,
  and setup choices into the existing worktree primitive. It does not duplicate `worktree create`'s
  project/host convenience resolver: `--on` already names the connected Orca server and `--repo`
  names the repository on that server.
- A gated setup receipt becomes `succeeded` only after the agent wrapper proves setup completed. A
  confirmed spawn/script failure fails before task input; timeout keeps `running` because silence is
  not failure.
- The existing single durable worker row is the operation stage journal. A pre-effect failure has no
  residuals, possible acceptance before receipt is unknown, and later failure after a durable effect
  lists exact residual resources. No background saga executor or general effect engine was added.
- Phase 4 is satisfied as an explicit conditional deferral. Orca still lacks an exact
  terminal-to-provider-session association, so adding an adapter now would violate the design.

### 2026-07-22 — Final setup/startup review

- Keep setup-run as the new-worktree orchestration default.
- Preserve Orca's existing `start-immediately` default: setup and agent run side by side.
- Only explicit `wait-for-setup` gates agent launch/task delivery.
- A custom-argv two-step terminal launch cannot preserve wait-for-setup and must not silently bypass
  it.
- Receipts must enumerate role-tagged agent, setup, and configured terminals; a boolean
  `setupSpawned` is insufficient.
- Setup outcome never gates readiness under start-immediately, regardless of observation timing.

### 2026-07-22 — Federation robustness review

- Multi-server operation is a core requirement, not a later optional product feature.
- Use a single authoritative Run home with narrow remote Dispatch attachments and bidirectional
  relay; do not replicate the Run database.
- Pin active Dispatches to authenticated peer identity so re-pairing cannot redirect work.
- Use contiguous, scoped relay sequences and bounded storage.
- Hide peer fingerprints, relay cursors, process incarnations, and capabilities from normal agents.

### 2026-07-22 — Validation and scope boundary

- Phase 0 and Phase 1 are complete: their command, recipe, Run, inbox, lifecycle, question,
  authority, and mutation-ledger acceptance rows now have focused passing tests.
- Phase 2 remains open until the full existing-worktree/explicit-terminal/setup-policy/failure-stage
  matrix is covered. Passing current/new-worktree and recovery slices are not enough to claim it.
- Phase 3 remains open until the named Mac/Windows, WSL, SSH, relay, restart, disconnect, and quoting
  matrix runs on those actual paths. The in-process federation harness proves protocol behavior but
  is not a substitute for cross-platform acceptance.
- Phase 4 stays deferred. V1 keeps bounded terminal observation and does not introduce a provider
  session abstraction merely to make the phase appear complete.

### 2026-07-21 — Simplification decision

- Replace the original broad orchestration redesign with four public concepts: Run, Task, Dispatch,
  and Message.
- Keep agent-owned strategy and strong control-plane primitives.
- Remove UI, scheduler, capacity allocation, access enforcement, commit/integration tracking,
  generalized provider/session abstractions, and other speculative product machinery.
- Retain Run because it provides a durable namespace and home mailbox across connected servers, not
  because it schedules work.

## Progress log

Append new entries chronologically. Do not rewrite older entries except to correct factual errors.

### 2026-07-22 — Checklist initialized

- Changes:
  - Created this tracked implementation ledger from the reviewed orchestration proposal.
  - Recorded all phases, acceptance tests, non-goals, and review-derived invariants.
  - Updated the current orchestration skill to prefer setup-run, preserve start-immediately, process
    message batches, prefer `agentTerminalHandle`, and reject custom-argv wait-policy bypass.
- Files:
  - `ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md`
  - `skills/orchestration/SKILL.md`
  - `docs/orchestration-primitives.html` (ignored design source)
- Verification:
  - HTML parsed successfully with balanced tags and unique IDs.
  - Final review Task completed without an architectural blocker.
- Findings:
  - Implementation may begin with Phase 0.
  - Phase 2 readiness/receipt work depends on the explicit setup and role-tagged-effect contracts
    recorded above.
- Next:
  - Finish Phase 0 command compatibility and version-matched recipes.

### 2026-07-22 — Phase 0 command safety and vocabulary

- Changes:
  - Renamed the scheduler-like command surface to `coordinator-start` and `coordinator-stop` while
    retaining `run` and `run-stop` as documented deprecated aliases.
  - Updated root help and both orchestration skill sources to distinguish the legacy automatic loop
    from the proposed lightweight Run namespace and to prefer the explicit task/dispatch/wait loop.
  - Made `orchestration reset` require exactly one of `--all`, `--tasks`, or `--messages` before it
    contacts the runtime.
  - Synchronized setup, worker-terminal selection, and message-batch guidance into the canonical
    guide and regenerated the bundled CLI guide.
- Files:
  - `src/cli/specs/orchestration.ts`
  - `src/cli/handlers/orchestration.ts`
  - `src/cli/help.ts`
  - `src/cli/handlers/orchestration.test.ts`
  - `src/cli/index.test.ts`
  - `src/main/runtime/orchestration-cli-subprocess.test.ts`
  - `skill-guides/orchestration.md`
  - `skills/orchestration/SKILL.md`
  - `src/cli/bundled-skill-guides.ts`
- Verification:
  - `pnpm vitest run --config config/vitest.config.ts src/cli/index.test.ts src/cli/handlers/orchestration.test.ts` — 199 tests passed.
  - `pnpm verify:bundled-skill-guides` — passed.
  - `pnpm typecheck:cli` — passed.
  - `git diff --check` — passed.
- Findings:
  - Keeping hidden compatibility aliases preserves existing scripts without advertising the old
    scheduler noun as the normal agent path.
  - Truthful success/failure recipes depend on the Phase 1 explicit lifecycle outcome; do not
    document the current behavior as if a failed `worker_done` failed the Task.
- Next:
  - Implement explicit succeeded/failed worker-report semantics and then finish the version-matched
    Phase 0 recipes without lying about failure behavior.

### 2026-07-22 — Truthful worker terminal outcomes

- Changes:
  - Added the structured `--outcome succeeded|failed` worker-report field to local and SSH fallback
    CLI payload construction and injected preambles.
  - Added one transactional compare-and-set that settles the Dispatch and Task together, promotes
    dependents only on success, and replays an identical terminal outcome idempotently.
  - Persisted worker result provenance, message identity, summary, files, and report path as a
    labeled `worker_report` rather than an Orca-verified result.
  - Converted missing, invalid, unknown, stale, mismatched, inactive, and foreign reports into
    typed, high-priority audit rows without mutating lifecycle state.
  - Updated the legacy automatic coordinator loop to record failed worker reports as failed tasks.
- Files:
  - `src/cli/specs/orchestration.ts`
  - `src/cli/handlers/orchestration.ts`
  - `src/main/ssh/ssh-remote-orchestration-send.ts`
  - `src/main/runtime/orchestration/types.ts`
  - `src/main/runtime/orchestration/db.ts`
  - `src/main/runtime/orchestration/lifecycle-reconciliation.ts`
  - `src/main/runtime/orchestration/preamble.ts`
  - `src/main/runtime/orchestration/coordinator.ts`
  - Corresponding CLI, SSH, preamble, DB lifecycle, coordinator, and RPC tests/snapshots
  - Both orchestration skill sources and the generated bundled guide
- Verification:
  - Five focused CLI/lifecycle/preamble/coordinator/SSH test files — 124 tests passed.
  - `src/main/runtime/rpc/methods/orchestration.test.ts` — 114 tests passed.
  - `pnpm typecheck:node` — passed.
  - `pnpm typecheck:cli` — passed.
  - `pnpm verify:bundled-skill-guides` and `git diff --check` — passed.
- Findings:
  - The old subject-based failure convention was not merely confusing: it irreversibly completed a
    failed Task. Requiring a tiny enum is a robust primitive, not workflow policy.
  - Stop and abandon still need to share this terminal-transition fence before the broader
    first-writer-wins checklist item can be marked complete.
- Next:
  - Add the lightweight Run schema and explicit coordinator binding, then key new Task/Dispatch/
    Message state to that Run without changing agent placement policy.

### 2026-07-22 — Lightweight Run foundation and inbox-only mail

- Changes:
  - Added schema v7 with lightweight Runs, stable explicit pane binding, consumer generations, and
    an inspect-only legacy Run for all migrated pre-Run rows.
  - Kept legacy automatic coordinator-loop storage in its existing `coordinator_runs` table.
  - Added `run-create`, `run-use`, `run-current`, `run-list`, and `run-show` across CLI/RPC, with
    explicit binding and no worktree or sole-candidate inference.
  - Scoped new Task creation/list/update/dispatch operations to an explicit or currently bound Run;
    Dispatches and decision gates inherit their Task's Run.
  - Removed structured-mail prompt injection from send and ask. Mail now persists and wakes waiters
    only; deliberate `dispatch --inject` and `terminal send` remain the input-writing paths.
  - Renamed the local message renderer from `check --inject` to `check --format`, retaining only a
    one-release RPC compatibility field.
- Files:
  - `src/main/runtime/orchestration/db.ts`
  - `src/main/runtime/orchestration/types.ts`
  - `src/main/runtime/rpc/methods/orchestration-runs.ts`
  - `src/main/runtime/rpc/methods/orchestration.ts`
  - `src/main/runtime/orchestration/orchestration-error.ts`
  - `src/main/runtime/rpc/errors.ts`
  - `src/cli/specs/orchestration.ts`
  - `src/cli/handlers/orchestration.ts`
  - Related DB, RPC, CLI, and help tests; both skill sources and the bundled guide
- Verification:
  - Focused DB/RPC/CLI command suite — 384 tests passed.
  - `pnpm typecheck:node` and `pnpm typecheck:cli` — passed.
  - `pnpm generate:bundled-skill-guides` and `pnpm verify:bundled-skill-guides` — passed.
  - `git diff --check` — passed.
- Findings:
  - Run identity is now real without changing scheduling or placement policy, but Messages and
    questions still need stable logical recipients before mandatory Run association is complete.
  - Consumer generation exists, but waiter cancellation and acknowledgment fencing belong to the
    crash-safe Delivery implementation and remain intentionally unchecked.
- Next:
  - Implement Run-owned logical mailboxes and stable `run:<id>` / `dispatch:<id>` routing, then
    replace consume-on-read with one crash-safe outstanding Delivery per Run.

### 2026-07-22 — Crash-safe Run inbox and durable questions

- Changes:
  - Added stable `run:<id>` and `dispatch:<id>` recipients; lifecycle sends from an active Dispatch
    now default to its Run and no longer require agents to carry a coordinator terminal handle.
  - Added schema v8 Deliveries: one FIFO batch of at most 50 rows, one outstanding batch per Run,
    exact replay until whole-batch acknowledgment, and consumer-generation fencing.
  - Made `check --ack <delivery> --wait` perform ack, check, and waiter registration without an
    intervening async gap; type filters are wake predicates and never split the FIFO batch.
  - Added typed timeout, cancellation/connection-loss, second-waiter, stale-Delivery, and fenced-
    consumer outcomes, plus persisted Delivery replay after an Orca database reopen.
  - Added schema v9 question threads keyed by the original message ID, with active-Dispatch Run
    defaulting, timeout-safe resume, current-consumer first-answer authority, idempotent replay, and
    conflicting-answer rejection.
  - Updated injected worker guidance and the orchestration skill so normal lifecycle and question
    commands omit internal Run/server identity and coordinators explicitly process/ack each batch.
- Files:
  - `src/main/runtime/orchestration/types.ts`
  - `src/main/runtime/orchestration/db.ts`
  - `src/main/runtime/orca-runtime.ts`
  - `src/main/runtime/rpc/methods/orchestration.ts`
  - `src/main/runtime/rpc/methods/orchestration-runs.ts`
  - `src/main/runtime/orchestration/preamble.ts`
  - CLI specs/handlers, RPC error mapping, skill sources, snapshots, and focused tests
- Verification:
  - DB/RPC/runtime/CLI/preamble focused suite — 1,190 tests passed after the expected preamble
    snapshot update.
  - Delivery tests cover 50-row bounds, FIFO replay, idempotent ack, filter wake semantics,
    consumer fencing, and reopen recovery.
  - Question tests cover create/answer, same-answer replay, answer conflict, timeout persistence,
    resume, unrelated wakes, and Dispatch closure storage behavior.
- Findings:
  - A Run inbox needs only one durable Delivery row plus immutable message IDs; no dead-letter,
    selective NACK, or second Event subsystem is necessary.
  - Question answers belong in thread state rather than inbox-read state, so replying never
    accidentally acknowledges the coordinator's whole Delivery.
- Next:
  - Replace caller-supplied pane claims with a narrow Dispatch capability and add the durable
    mutation ledger needed to recover unknown acceptance without replaying effects.

### 2026-07-22 — Narrow Dispatch lifecycle capability

- Changes:
  - Minted a 256-bit per-Dispatch secret for injected workers while persisting only its SHA-256
    verifier.
  - Bound lifecycle/question authority to the exact runtime-observed pane and PTY process
    incarnation in addition to the Dispatch ID.
  - Carried the secret in the authenticated RPC envelope across local socket, WebSocket,
    shared remote-runtime, and SSH fallback transports rather than orchestration payload fields.
  - Revoked the capability when worker completion/failure settles the Dispatch and stopped trusting
    caller-supplied pane metadata in the SSH fallback.
- Files:
  - `src/main/runtime/orchestration/db.ts`
  - `src/main/runtime/orchestration/types.ts`
  - `src/main/runtime/orchestration/preamble.ts`
  - `src/main/runtime/rpc/core.ts`
  - `src/main/runtime/rpc/dispatcher.ts`
  - `src/main/runtime/rpc/methods/orchestration.ts`
  - CLI and remote transport implementations plus focused tests
- Verification:
  - Ten focused DB/RPC/runtime/CLI/SSH files — 1,238 tests passed.
  - Capability cases cover missing token, wrong token, wrong pane, changed process incarnation,
    success, and post-settlement revocation.
  - `pnpm typecheck:node` and `pnpm typecheck:cli` — passed.
- Findings:
  - Terminal handles and environment-provided pane strings are useful routing metadata but are not
    lifecycle authority.
  - Stop, abandon, and replacement must use the same revocation fence before that remaining
    checklist item can be completed.
- Next:
  - Add the durable mutation ledger and use it to recover unknown acceptance without repeating
    external effects.

### 2026-07-22 — Durable mutation receipts

- Changes:
  - Added schema v11 mutation receipts keyed by an authenticated-caller fingerprint and opaque
    request ID, with canonical payload hashing and pending/completed state.
  - Replayed completed results across retries and restart, joined concurrent identical mutations,
    rejected changed input as `request_mismatch`, and surfaced orphaned pending work as
    `operation_unknown`.
  - Added request IDs to local socket, named-pipe, WebSocket, saved-environment, and SSH fallback
    envelopes; successful receipts echo the ID while transport failures retain it as recovery data.
  - Persisted blocking-question acceptance before waiting, so retry after a lost response returns
    the original question instead of creating another.
- Files:
  - `src/main/runtime/orchestration/db.ts`
  - `src/main/runtime/orchestration/types.ts`
  - `src/main/runtime/rpc/core.ts`
  - `src/main/runtime/rpc/dispatcher.ts`
  - Runtime-client and transport files, CLI orchestration handlers/specs, and focused tests
- Verification:
  - Twelve focused DB/RPC/runtime/CLI/SSH files — 1,260 tests passed.
  - `pnpm typecheck:node`, `pnpm typecheck:cli`, and `git diff --check` — passed.
- Findings:
  - Generic control-plane mutations can safely discard a pending receipt when their handler returns
    a known failure; future worker start/stop must instead return and preserve typed unknown outcomes
    around external effects.
  - The ledger infrastructure covers every existing V1 mutation; worker start/stop/abandon will be
    added to the same policy when those commands exist.
- Next:
  - Implement the same-server worker lifecycle and its first-writer-wins stop/abandon fence.

### 2026-07-22 — Same-server worker lifecycle foundation

- Changes:
  - Added schema v12 composed-worker state and created the starting Dispatch plus Task transition
    before terminal effects.
  - Added synchronous `worker-start` for the current or an exact existing worktree, with fresh-agent
    default, explicit-terminal reuse, TUI readiness, capability attachment, lifecycle injection, and
    honest failed receipts with residual resources.
  - Added Dispatch-routed `worker-show` and bounded `worker-read`.
  - Added first-writer-wins `worker-stop` and `worker-abandon`; stop closes only the supervised agent
    terminal, while abandon performs no process/filesystem action and retains residual receipts.
  - Closed and woke pending question waits when a worker is settled, stopped, or abandoned.
- Files:
  - `src/main/runtime/orchestration/db.ts`
  - `src/main/runtime/orchestration/types.ts`
  - `src/main/runtime/rpc/methods/orchestration-workers.ts`
  - `src/main/runtime/rpc/methods/orchestration.ts`
  - `src/main/runtime/orca-runtime.ts`
  - CLI orchestration specs/handlers and focused DB/RPC/CLI tests
- Verification:
  - Focused DB/RPC/CLI command suite — 412 tests passed.
  - `pnpm typecheck:node` and `pnpm typecheck:cli` — passed.
- Findings:
  - Keeping composed state in a narrow extension table preserves legacy Dispatch compatibility while
    giving worker operations the richer start/stop states they need.
  - New-worktree setup, stage journaling around worktree creation, and true unknown-start recovery
    remain open; current/existing workers are the verified slice.
- Next:
  - Add agent-first child/top-level creation with setup-run default and startup-policy receipts, then
    extend the same Dispatch routing across connected Orca servers.

### 2026-07-22 — Agent-first new-worktree workers and setup receipts

- Changes:
  - Added child and top-level agent-first worktree creation to `worker-start`, reusing the exact
    startup agent terminal and listing setup/configured terminals as role-tagged effects.
  - Made omitted setup resolve to `run`, preserved explicit run/skip/inherit and repository startup
    policy, and returned `not_configured` when no setup hook exists.
  - Kept `start-immediately` setup non-gating, persisted later setup success/failure, and emitted a
    typed Run notice without changing a ready worker's lifecycle state.
  - Narrowed setup receipts to callers that explicitly await terminal provisioning so ordinary
    worktree creation does not report renderer-delegated setup as a false spawn failure.
  - Added typed unknown-start recovery when worktree creation may have been accepted before a
    connection failure.
- Files:
  - `src/main/runtime/orca-runtime.ts`
  - `src/main/runtime/rpc/methods/orchestration-workers.ts`
  - `src/main/runtime/rpc/methods/orchestration-workers-new-worktree.test.ts`
  - `src/main/runtime/rpc/methods/orchestration.test.ts`
  - `src/shared/types.ts`
- Verification:
  - New-worktree worker scenarios — 8 tests passed.
  - Worker RPC plus runtime worktree suites — 911 tests passed.
  - `pnpm typecheck:node` — passed.
- Findings:
  - A setup status is only truthful after the supervised caller awaits the runtime's terminal
    provisioning result; normal renderer-delegated creation should retain its existing launch
    payload instead.
  - The generic mutation receipt and starting Dispatch are still separate commits, so atomic start
    acceptance and crash-boundary reconciliation remain open.
- Next:
  - Make worker-start acceptance one transaction, then add restart reconciliation that never adopts
    a same-looking pane or process.

### 2026-07-22 — Atomic worker acceptance and conservative restart recovery

- Changes:
  - Moved the worker-start retry request insertion into the same SQLite transaction that creates the
    starting Dispatch and moves its Task to dispatched.
  - Added a process runtime epoch to composed Dispatches so interrupted starts/stops become explicit
    unknown outcomes after restart instead of remaining indefinitely in transitional states.
  - Made worker show/read/stop verify the persisted stable pane plus exact PTY process incarnation;
    a same-looking replacement is reported as changed and is never read or closed.
  - Restricted semantic retry to the Task's latest failed, stopped, or abandoned Dispatch.
- Files:
  - `src/main/runtime/orchestration/db.ts`
  - `src/main/runtime/orchestration/types.ts`
  - `src/main/runtime/rpc/core.ts`
  - `src/main/runtime/rpc/dispatcher.ts`
  - `src/main/runtime/rpc/errors.ts`
  - `src/main/runtime/rpc/methods/orchestration-workers.ts`
  - Focused DB, mutation-ledger, new-worktree, and recovery tests
- Verification:
  - Atomic acceptance and recovery suite — 231 tests passed.
  - Follow-up DB/recovery/new-worktree suite — 93 tests passed.
  - `pnpm typecheck:node` — passed.
- Findings:
  - Runtime ID is useful only as a process epoch. It is not a durable server identity and must not be
    used to route federated Dispatches.
  - After restart, preserving uncertainty is safer than adopting a restored pane: the prior worker
    may still exist, but only explicit stop/abandon/retry recovery may replace it.
- Next:
  - Audit and close the remaining same-server acceptance rows, then implement saved-environment
    placement and the narrow federated Dispatch attachment.

### 2026-07-22 — Connected-server federation and crash-safe relay

- Changes:
  - Added worker-only `--on <saved-environment>` placement while keeping Run/Task authority on the
    current server and routing later show/read/stop operations solely by Dispatch ID.
  - Pinned remote Dispatches to the saved server public-key fingerprint and stored runtime identity
    only as a replaceable process epoch; re-pairing returns `peer_changed` before effects.
  - Added a narrow worker-server attachment with protocol version, capability verifier, exact
    pane/process identity, effects, setup state, and bidirectional relay cursors—without copying the
    Run DAG.
  - Added durable worker-to-home lifecycle/question relay and home-to-worker reply relay with
    contiguous sequence checks, source acknowledgment, quotas, heartbeat coalescing, and reserved
    terminal-report capacity.
  - Made home import commit the message, question/lifecycle transition, and source cursor in one
    transaction before acknowledgment.
  - Added federated show/read/stop, stop/completion ordering, timeout/resume after worker restart,
    relay restart, exact-process checks, ack-loss replay, gap rejection, peer-change fencing, and
    POSIX database/WAL/SHM permission coverage. Windows uses Orca's existing current-user-only
    userData DACL boundary.
  - Added an agent-facing cookbook for local fan-out, setup-default new worktrees, Mac/Windows
    placement, completion/failure, ask/resume/reply, and conditional recovery.
- Files:
  - `src/main/runtime/orchestration/environment-transport.ts`
  - `src/main/runtime/orchestration/federation-sync.ts`
  - `src/main/runtime/orchestration/db.ts`
  - `src/main/runtime/rpc/methods/orchestration-federation.ts`
  - `src/main/runtime/rpc/methods/orchestration-workers.ts`
  - Federation, permissions, CLI, transport, skill-guide, and protocol capability tests/sources
- Verification:
  - Federation scenarios — 14 tests passed.
  - Federation plus database-permission scenarios — 15 tests passed.
  - Focused database/lifecycle/federation regression suite — 111 tests passed.
  - `pnpm typecheck:node` and bundled skill-guide verification — passed.
- Findings:
  - The stable saved-environment public-key fingerprint is server identity; a runtime UUID is only an
    epoch and must never retarget a Dispatch after restart.
  - The worker server needs only an authenticated attachment and relay outbox, not a replicated Run
    database, scheduler, callback listener, or general ACL system.
  - Setup remains explicit in receipts but non-gating by default; only repository
    `wait-for-setup` policy delays agent launch.
- Next:
  - Run the complete orchestration/CLI regression matrix, close any remaining checklist gaps, then
    run repository validation and prepare the commit/PR.

### 2026-07-22 — Final modularization and verification pass

- Changes:
  - Split federation, worker control/observation/topology, mutation execution, CLI specs, runtime
    transport support, SSH error formatting, and database/CLI tests into domain-named modules so no
    new max-lines bypass was needed.
  - Regenerated the bundled skill manifests after the orchestration guide changed.
  - Updated skill-guidance and lifecycle-rejection tests for the renamed legacy coordinator command,
    setup-run default, agent-terminal fallback, and mandatory worker outcome.
  - Kept unrelated daemon/UI/localization baseline failures out of the orchestration diff.
- Files:
  - `src/main/runtime/rpc/methods/orchestration-federation-*.ts`
  - `src/main/runtime/rpc/methods/orchestration-worker-*.ts`
  - `src/main/runtime/orchestration/orchestration-*-db.test.ts`
  - `src/main/runtime/rpc/orchestration-mutation-executor.ts`
  - `src/main/runtime/rpc/runtime-feature-interaction.ts`
  - `src/main/ipc/runtime-environment-shared-control-support.ts`
  - `src/cli/specs/orchestration-worker-specs.ts`
  - `src/cli/handlers/orchestration-run-cli.test.ts`
  - `src/main/ssh/ssh-remote-cli-error-response.ts`
- Verification:
  - Focused orchestration/CLI/SSH suite: 20 files, 565 tests passed.
  - Runtime/subprocess/transport suite: 780 passed, 2 skipped.
  - Updated skill-guidance/lifecycle-rejection tests: 12 passed.
  - Full TypeScript check (Node, CLI, web), ordinary `oxlint`, max-lines ratchet, reliability gates,
    bundled guide verification, manifest verification, and localization catalog verification passed.
  - `pnpm test` could not start because the patched `node-pty` artifact does not load under local
    Node 24.18.0. Direct full Vitest ran 33,058 passing tests; its 24 remaining failures and 3 worker
    errors were native-PTY or unrelated timeout/baseline failures after the three stale
    orchestration assertions were fixed and rerun.
  - Full `pnpm lint` remains blocked only by unrelated existing switch-exhaustiveness and
    localization-coverage failures outside this change.
- Findings:
  - The implemented protocol has a clean authority split: the Run home owns orchestration truth;
    connected worker servers own only exact resources, an authenticated Dispatch attachment, and
    durable relay state.
  - The remaining unchecked Phase 2/3 rows are real acceptance work, not reasons to add a scheduler,
    UI, generalized capability matrix, provider-session layer, or automatic recovery.
- Next:
  - Add the missing focused Phase 2 scenarios and run the Phase 3 matrix on real Mac/Windows and
    WSL/SSH paths before marking those phases complete.

### 2026-07-22 — Phase 2 setup and receipt acceptance complete

- Changes:
  - Made wait-for-setup receipts settle to `succeeded` only after gated agent readiness and fail at
    `setup_start` or `setup_wait` before lifecycle/task input when setup is confirmed failed.
  - Preserved `running` on a gated timeout, avoiding a false setup-failure claim.
  - Added stage, role-tagged dispatch input, rich setup effect data, and exact terminal tab/leaf
    coordinates to composed-worker receipts.
  - Kept worker-start's option surface narrow: exact server via `--on`, exact repo via `--repo`, and
    pass-through base/lineage/display/comment/setup choices.
  - Updated CLI help, both skill sources, the generated guide/manifests, and the ignored HTML design.
- Files:
  - `src/main/runtime/rpc/methods/orchestration-workers.ts`
  - `src/main/runtime/rpc/methods/orchestration-worker-topology.ts`
  - `src/main/runtime/rpc/methods/orchestration-federation.ts`
  - `src/main/runtime/rpc/methods/orchestration-federated-worker-start.ts`
  - `src/main/runtime/rpc/methods/orchestration-federation-effects.ts`
  - Focused worker, federation, and CLI tests plus help/skill/checklist/design sources
- Verification:
  - Local/new-worktree/federation worker suites: 166 tests passed.
  - CLI handler/help suite: 197 tests passed.
  - Full Node/CLI/web TypeScript check passed.
- Findings:
  - The existing worktree startup wrapper already enforces setup-before-agent ordering; the missing
    work was truthful orchestration state and acceptance coverage, not a second setup runner.
  - Phase 2 is complete. Remaining unchecked rows are the real connected-platform Phase 3 matrix
    and cross-platform transport evidence.
- Next:
  - Exercise federation disconnect/reorder/restart semantics, then run branch-head Mac/Windows
    acceptance without replacing either production Orca runtime.

### 2026-07-22 — Native Mac-to-Windows acceptance gaps

- Changes:
  - Built and launched branch-head Mac and Windows servers on isolated profiles and paired them over
    the existing authenticated WebSocket transport.
  - Used a temporary, exact Tailscale TCP proxy because Windows Firewall correctly blocked the new
    test-binary port; production Orca and firewall policy were left unchanged.
  - Added explicit dev-CLI provenance so custom profile paths still generate `orca-dev` worker
    commands.
  - Increased only the Windows ConPTY bracketed-paste render gap before Enter from 500 ms to 1.5 s.
- Files:
  - `config/scripts/orca-dev.mjs`
  - `src/cli/handlers/orchestration.ts`
  - `src/shared/agent-prompt-injection.ts`
  - Focused wrapper, CLI, and prompt-injection tests
- Verification:
  - Native Windows discovery, exact worktree routing, pre-effect failure, retry, ready receipt,
    worker-read, and remote worker-stop all returned truthful branch-head receipts.
  - Focused dev-provenance and prompt-injection suite: 160 tests passed.
- Findings:
  - A fresh Windows agent profile surfaces trust/login/update prompts as typed `agent_readiness`
    failures with residual terminals, as designed.
  - The first authenticated Windows worker proved that 500 ms could leave a long preamble in the
    Codex input buffer, and that a custom dev profile could incorrectly call the production CLI.
  - Phase 3 remains open until the fixes are rebuilt on Windows and the full completion/question/
    failure/restart matrix succeeds without a manual Enter or CLI substitution.
- Next:
  - Rebuild both branch servers with these fixes and repeat the real Mac-home to Windows-worker flow.

### 2026-07-22 — Headless Windows dev-worker CLI routing

- Changes:
  - Made every `orca-dev` entry path install profile-scoped `orca-dev` and `orca` terminal wrappers,
    including Windows `.cmd` wrappers and headless `orca-dev serve`.
  - Kept the wrapper generation shared with the Electron dev runner so interactive and headless dev
    servers expose the same exact CLI and user-data profile to worker terminals.
- Files:
  - `config/scripts/dev-cli-terminal-wrapper.mjs`
  - `config/scripts/orca-dev.mjs`
  - `config/scripts/run-electron-vite-dev.mjs`
  - Focused cross-platform wrapper tests
- Verification:
  - Wrapper, CLI provenance, dev-runner, preamble, and orchestration handler suites: 55 tests passed.
  - Focused oxlint and formatting checks passed.
- Findings:
  - The rebuilt prompt submitted automatically on Windows, but the worker then found no
    profile-scoped `orca-dev` command because headless serve bypassed the Electron dev runner and the
    runner itself had never written Windows wrappers into the PATH directory used by Orca terminals.
  - This is a dev/acceptance launcher defect, not a new federation primitive or production routing
    requirement.
- Next:
  - Rebuild and restart the Windows branch server, then repeat the same Dispatch and require an
    automatically relayed `worker_done` before checking any federation acceptance row.

### 2026-07-22 — Mac-home to Windows-worker federation accepted

- Changes:
  - Fast-forwarded and restarted the isolated Windows branch server with the profile-scoped wrapper
    fix while preserving its authenticated server key and saved-environment binding.
  - Exercised separate success, intentional failure, and blocking question/reply Dispatches from the
    isolated Mac Run home to native Windows Codex workers.
- Files:
  - `ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md`
- Verification:
  - Success `ctx_f982ddb1bdf9` submitted without manual input, relayed `worker_done`, and atomically
    settled its Task/Dispatch as completed/succeeded.
  - Failure `ctx_5f28665cf04a` relayed `outcome=failed` and atomically settled its Task/Dispatch as
    failed without treating failure prose as success.
  - Question `ctx_4aec24c47e30` relayed a typed question to the Mac Delivery, carried the `blue` reply
    back to the blocked Windows ask, then relayed a successful terminal report.
  - Routed bounded read and exact-agent stop were also exercised against Windows Dispatch receipts;
    stop closed only the accepted agent terminal.
- Findings:
  - Windows ConPTY prompt submission, profile-specific CLI selection, authenticated lifecycle
    acceptance, contiguous bidirectional relay, whole-batch acknowledgment, and terminal-state
    reconciliation now pass together in the real Mac-to-Windows path.
  - This completes only the named Mac-home to Windows-worker row; reverse direction, restart with an
    active Dispatch, disconnect/unknown-outcome, WSL/SSH/relay-host, and transport coverage remain
    open.
- Next:
  - Pair the isolated Mac server into the Windows test profile and run the same acceptance flow with
    Windows as the Run home.

### 2026-07-22 — Windows-home to Mac-worker federation accepted

- Changes:
  - Added a reciprocal saved Mac environment to the isolated Windows profile without exposing its
    pairing credential in terminal history.
  - Exercised separate success, intentional failure, blocking question/reply, bounded read, and exact
    stop Dispatches with Windows as Run home and native macOS as worker server.
  - Made worker observations report `exited` for the exact disconnected terminal instead of
    misleadingly projecting `running`; stop now refuses to close an exact-but-exited process again.
- Files:
  - `src/main/runtime/rpc/methods/orchestration-worker-observation.ts`
  - `src/main/runtime/rpc/methods/orchestration-federation-control.ts`
  - `src/main/runtime/rpc/methods/orchestration-worker-stop.ts`
  - Focused local/federated observation and stop tests
- Verification:
  - Success `ctx_5188e1f8417e` relayed from macOS and settled at the Windows Run home.
  - Failure `ctx_a3418dc84ed6` relayed `outcome=failed` and settled failed at the Windows home.
  - Question `ctx_a2521b88b6c9` carried `square` from Windows to the blocked macOS ask, followed by a
    successful terminal report.
  - Stop `ctx_bec120349d3f` first proved routed read against the exact Mac worker, then closed only that
    terminal and settled stopped/failed; the observation regression suites pass 36 tests.
- Findings:
  - One reciprocal pairing is sufficient for a Windows-owned Run to route Mac worker control while
    preserving a single Run database on Windows; no replicated scheduler or failover layer is needed.
  - Stable process identity and live process status are separate facts. A disconnected terminal can
    still be the exact historical worker, but it must not be labeled running or closed again.
- Next:
  - Validate active-Dispatch restart/disconnect and exact-retry behavior, then exercise WSL/SSH/relay
    execution-host propagation without broadening the federation protocol.

### 2026-07-22 — Federated restart and pre-acceptance disconnect accepted

- Changes:
  - Restarted the Windows Run home alone, the macOS worker server alone, and both servers while each
    had an active federated Dispatch.
  - Stopped the macOS worker server before a Windows-home start request could be accepted.
- Files:
  - `ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md`
- Verification:
  - Home-only restart preserved `ctx_f0693ff30c27`; `worker-show` found the same exact running macOS
    worker under the unchanged worker epoch, and routed stop succeeded.
  - Worker-only restart preserved `ctx_3bbb0142f9aa` at its Run home while the new macOS epoch
    truthfully reported the missing terminal as non-exact; routed stop returned `stop_unknown`
    without adopting or closing another process.
  - Restarting both sides preserved `ctx_d46f68fa1400` and its attachment; inspection used the new
    worker epoch, reported `missing` with `exactWorker=false`, and stop again returned
    `stop_unknown` safely.
  - With macOS already unreachable, retry request `disconnect-before-send-01` created neither a
    Dispatch nor an attachment for `task_04fd0dc61065`; the Task remained ready.
- Findings:
  - Durable home state and worker identity fencing survive independent epochs without requiring Run
    replication or authority failover.
  - A failed connection before remote acceptance is a clean no-effect result; it must not be
    promoted to an ambiguous outcome or consume the Task.
- Next:
  - Disconnect the worker route after possible acceptance, then follow the returned exact recovery
    command and prove that retry deduplicates to one remote effect.

### 2026-07-22 — Post-acceptance disconnect deduplicated

- Changes:
  - Cut the Windows Tailscale proxy while a Mac-home `worker-start` was provisioning remotely, then
    restored the same route and replayed the exact application request ID.
  - Allowed an explicit `worker-stop` to fence `start_unknown` locally and on the worker server;
    exact pane/process observation still decides whether a terminal may actually be closed.
- Files:
  - `src/main/runtime/orchestration/db.ts`
  - `src/main/runtime/orchestration/orchestration-worker-dispatch-db.test.ts`
  - `ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md`
- Verification:
  - The lost response left `task_bb86c87bdc60` attached to one pending Dispatch,
    `ctx_6580d07d9006`, rather than creating a replacement.
  - Replaying request `disconnect-after-start-01` returned the same Dispatch with
    `state=outcome_unknown` and `mutation.replayed=true`.
  - Remote inspection found one `disconnect-after-acceptance-01` worktree, one exact agent
    terminal, and one expected setup terminal; no duplicate topology was created.
  - Worker Dispatch DB, federated control, and recovery suites passed 29 tests; node typecheck and
    focused oxlint passed. Branch-head CLI and Electron builds succeeded on macOS and Windows.
  - Relay tests reject an out-of-order sequence without advancing the cursor, later accept the
    missing and retried frames contiguously, treat the repeated frame as a duplicate, and preserve
    exactly two messages. Lost-ack retry and mailbox delivery suites passed with it (24 tests).
- Findings:
  - The acceptance run exposed one narrow recovery inconsistency: `worker-show` could prove an exact
    worker existed while `worker-stop` rejected the durable `start_unknown` state. Explicit stop now
    enters the same fenced stopping path from `ready` or `start_unknown`; unattached, missing, or
    identity-changed workers still become `stop_unknown` without a process action.
  - No scheduler, automatic retry, adoption, cleanup, or general distributed-operation framework is
    needed for this recovery path.
- Next:
  - Exercise duplicate/reordered relay convergence and the native/WSL/SSH transport matrix, then
    synchronize the HTML proposal with the implemented contract.

### 2026-07-22 — Cross-platform capability transport verified

- Changes:
  - Added an SSH compatibility-bridge test that carries the opaque Dispatch capability in the RPC
    envelope and settles only the matching pane/process Dispatch.
  - Added a composed worker-start test that binds the host-resolved `orca-ide` command and the
    Dispatch capability into one WSL worker preamble.
  - Updated the built-CLI reset fixture to recreate its required coordinator Run after a task reset.
  - Updated the HTML recovery contract so explicit stop from `start_unknown` remains fenced and
    process-identity checked.
- Files:
  - `src/main/ssh/ssh-remote-orca-cli.test.ts`
  - `src/main/runtime/rpc/methods/orchestration-workers-new-worktree.test.ts`
  - `src/main/runtime/orchestration-cli-subprocess.test.ts`
  - `docs/orchestration-primitives.html` (ignored design source)
  - `ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md`
- Verification:
  - Native macOS Unix-socket worker control, native Windows named-pipe lifecycle reporting, and
    bidirectional authenticated WebSocket federation passed in the real Mac/Windows matrix.
  - On the real Windows host, the PowerShell/SSH launcher, SSH command allowlist, host passthrough,
    WSL/native command selection, and multiline Windows quoting suites passed 31 tests; 13
    Unix-socket-only runtime-client tests correctly skipped on Windows.
  - Platform-neutral SSH capability, WSL command selection, preamble, worker-start, and CLI envelope
    suites passed 94 focused tests on macOS.
  - The rebuilt CLI plus every orchestration, composed-worker, federation, and SSH regression file
    passed together: 25 files and 456 tests. Full Node/CLI/web typecheck, focused oxlint/format,
    generated-skill verification, and `git diff --check` passed.
- Findings:
  - The available Windows acceptance host has no WSL distribution installed and prompts to install
    the feature. Acceptance therefore uses explicit WSL host/path tests rather than mutating the
    machine. SSH is likewise exercised at the bridge and lifecycle boundary rather than requiring a
    new external host.
  - Native and relay-backed behavior is real end-to-end evidence; WSL and SSH evidence is bounded to
    the host-selection, prompt, envelope, quoting, allowlist, and lifecycle contracts Orca owns.
- Next:
  - Run the remaining full validation and Linux CI, then finish the ignored HTML synchronization and
    PR evidence without adding new orchestration concepts.

### 2026-07-22 — Phase 3 and cross-platform gates closed

- Changes:
  - Marked connected-server federation and the native cross-platform quality gate complete after
    branch-head Linux CI joined the real macOS/Windows acceptance evidence.
- Files:
  - `ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md`
- Verification:
  - PR #9925 completed with 17 successful checks and no failures: full Linux verify, Ubuntu and
    Windows native smoke, packaged Windows crash survival, and macOS/Ubuntu/Windows skill round trips.
  - Linux verify passed lint, generated-skill checks, max-lines enforcement, typecheck, repository-
    wide tests, unpacked-app build, and packaged CLI smoke.
- Findings:
  - Every implementation phase is now either complete or explicitly deferred with its prerequisite;
    no additional orchestration subsystem is required for V1.
- Next:
  - Review and merge PR #9925; keep Phase 4 deferred until exact provider-session association exists.

### 2026-07-22 — Final agent-contract audit

- Changes:
  - Synchronized the ignored HTML examples with the shipped mutation, Delivery, worker-start, and
    terminal-read result shapes; removed speculative Phase 4 output fields from the V1 path.
  - Made semantic retry explicitly repeat placement and agent/terminal choices, while transport
    recovery reuses only the exact `mutation.requestId` after a lost response.
  - Corrected worker state/error terminology, the cross-platform structured completion recipe, and
    the HTML implementation-status footer.
  - Updated the installed/versioned orchestration guidance to prefer `worker-start`, use
    `question` mail, and reserve low-level `dispatch --inject` for custom topology.
  - Fixed `worker-read --cursor 0`; the runtime supported the initial retained-output cursor but the
    orchestration CLI incorrectly required a positive value.
- Files:
  - `src/cli/handlers/orchestration.ts`
  - `src/cli/handlers/orchestration-worker-cli.test.ts`
  - `src/cli/specs/orchestration-worker-specs.ts`
  - `skill-guides/orchestration.md`
  - `skills/orchestration/SKILL.md`
  - generated bundled skill guide and skill-bundle manifests
  - `docs/orchestration-primitives.html` (ignored design source)
  - `ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md`
- Verification:
  - Focused worker CLI suite passed 3 tests, including cursor zero.
  - Final orchestration runtime/CLI/renderer/skill regression set passed 24 files and 450 tests.
  - Node, CLI, and web typechecks, bundled-guide and skill-manifest verification, focused
    formatting, and `git diff --check` passed.
  - A repository-wide run reached 34,190 passing tests and exposed the one intentionally changed
    skill assertion; after updating that assertion, the focused configured rerun above passed. The
    broad run also exhausted several Vitest fork-start deadlines under full local concurrency, while
    the previously green PR checks remain the authoritative clean full-suite baseline.
- Findings:
  - The implementation already returned durable request IDs as `mutation.requestId`; the remaining
    problem was stale naming and invented provenance fields in the ignored design example.
  - Stored start options are recovery evidence, not implicit replacement policy. Requiring explicit
    replacement placement keeps agents in control and avoids recreating a possibly-existing remote
    worktree by accident.
  - No new scheduler, retry engine, output adapter, projection layer, or federation subsystem is
    needed. Phase 4 remains deferred.
- Next:
  - Push the audit corrections and confirm PR #9925 is green at the new head.

### 2026-07-22 — CodeRabbit and internal review until clean

- Changes:
  - Validated every CodeRabbit finding; fixed relay type validation, stale runtime-owned terminal
    identity, setup receipt classification, Windows batch percent escaping, worker reconciliation,
    root-help discovery, canonical question schema, and deterministic waiter timing.
  - Coalesced overlapping per-Dispatch federation polls and added one warning per outage window.
  - Centralized the orchestration RPC envelope type without adding a new runtime abstraction.
  - Made reset scopes atomic and cleared matching worker/federation state while preserving relay
    cursors for message-only resets and the mutation ledger needed for lost-response deduplication.
- Files:
  - orchestration runtime, federation, worker-control, database, CLI help/client, wrapper, skill, and
    focused regression tests listed in the current working diff.
- Verification:
  - Focused runtime, federation, database, CLI, SSH, wrapper, and skill suites passed 1,103 tests.
  - The repository-wide configured suite passed 34,253 tests with 58 intentional skips.
  - Node, CLI, and web typechecks passed; focused oxlint, formatting, generated-skill checks, and
    `git diff --check` passed.
- Findings:
  - The type-only pairing import is valid TypeScript and remains type-only; Dispatch capability
    flags stay intentionally hidden because the authenticated worker preamble supplies them.
  - Persistent envelope-bearing WebSocket reuse remains a measured-later optimization; the V1
    single-flight relay removes overlapping connection churn without growing transport scope.
  - The final re-review found no remaining in-scope correctness, ergonomics, elegance, or
    performance defect after fixing reset scope and relay-cursor preservation in round 2.
  - Full lint reaches unrelated existing failures in the unchanged skill-freshness switch and
    localization catalog; changed-file lint and every in-scope quality gate pass.
- Next:
  - Resolve CodeRabbit threads and confirm the PR checks at the final head.

### 2026-07-24 — Post-rebase physical federation dogfood

- Changes:
  - Rebased the branch onto current main and launched isolated branch-head desktop runtimes on the
    Mac Run home and the physical Windows worker server.
  - Started a real Windows Codex worker in a new top-level worktree with explicit setup-run.
  - Replaced the orchestration process fence's renderer generation with the controller-issued PTY
    incarnation when available, retaining the prior value only for legacy providers.
  - Added a runtime regression covering a visible terminal surface detaching and reattaching around
    the same process, followed by a replacement incarnation.
- Files:
  - `src/main/runtime/orca-runtime.ts`
  - `src/main/runtime/orca-runtime.test.ts`
  - `ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md`
- Verification:
  - The remote start returned ready in about nine seconds with setup `running`,
    `startupPolicy=start-immediately`, one agent terminal, one setup terminal, and accepted task
    input.
  - The original branch head then reproduced immediate `identity_changed`: routed read failed and
    the exact injected capability could not send a heartbeat or question.
  - The new focused process-identity regression passed, the 18-test federation suite passed, and
    Node typecheck passed.
- Findings:
  - A renderer pane generation is presentation state, not process identity. A healthy PTY can move
    between a runtime-owned background surface and the renderer without losing Dispatch authority.
  - The PTY controller incarnation is already available on native Windows/macOS and SSH/relay paths;
    using it fixes the race without relaxing replacement-process fencing or adding a new identity
    subsystem.
- Next:
  - Rebuild both branch runtimes, repeat the full physical Mac-to-Windows lifecycle, then run the
    remaining local error/recovery matrix before closing the revalidation rows.

### 2026-07-24 — Post-fix physical federation revalidation

- Changes:
  - Rebuilt and restarted the physical Windows branch runtime from `b09c635ec`, then repeated the
    Mac Run-home to Windows-worker flow on a fresh top-level worktree.
  - Abandoned the controlled stale-build attempt, linked the replacement with `--retry-of`, and
    exercised exact start-request replay plus exact remote worker stop.
  - Exercised missing-agent and invalid-remote-repo rejection without adding recovery automation.
- Verification:
  - The replacement returned ready while setup was running under `start-immediately`;
    `worker-show` reported the exact running process, bounded `worker-read` succeeded, and the
    worker's heartbeat reached the Mac Run home.
  - An inferred-Run blocking question carried the `blue` reply back to Windows, and the authenticated
    success report atomically settled the Task and Dispatch.
  - A transient connection close before acceptance left the second Task ready with no Dispatch.
    Retrying its exact request ID started one worker, and repeating that request returned the same
    Dispatch with `replayed=true` and no duplicate worktree or terminal.
  - `worker-stop` killed only the exact agent PTY. The setup terminal remained present, the Dispatch
    became stopped/failed, and the Task became blocked for explicit recovery.
  - An unconfigured agent failed locally. A missing remote repo produced a typed failed Dispatch
    with `effects=[]` and no residual resources.
- Findings:
  - The first repeated failure was a stale Windows build artifact, not a failed fix: the source
    checkout was at `b09c635ec` while `out/main/index.js` still had the old generation fence.
    Relaunching the branch dev process produced a new runtime epoch and the fixed behavior.
  - Omitted setup correctly resolved to Orca's `run` default. Its independent Windows install later
    failed in `windows-native-registry`, but that did not delay task delivery and remained isolated
    from exact agent stop.
  - From an unmanaged shell, a coordinator mailbox check must name `--terminal`; a CLI running
    inside the bound coordinator terminal continues to infer that identity normally.
- Next:
  - Resolve only concrete findings from the independent ergonomics/federation re-review, run the
    final local verification set, and reconcile PR review threads and CI.

### 2026-07-24 — Post-dogfood recovery and ergonomics hardening

- Changes:
  - Made lost remote stop responses reconcilable and prevented stale Dispatch abandonment from
    blocking an active replacement.
  - Persisted setup completion as evidence only, preserving settled lifecycle state locally and
    relaying the same outcome from a connected worker server.
  - Rejected misleading explicit targets from federated workers and consumed `ask` answers exactly
    once while retaining their durable thread record.
  - Stored the accepted Dispatch in pending worker-start receipts so a post-restart retry returns the
    exact inspection command.
  - Rejected new-worktree placement for folder projects before effects.
  - Restored the generated skill-history ledgers that the branch had accidentally truncated.
- Verification:
  - The full orchestration DB/RPC/CLI/SSH regression selection passed 516 tests; its focused
    recovery, setup, messaging, and mutation slice passed 239 tests.
  - The earlier physical Mac-home to Windows-worker lifecycle covered ready/read/heartbeat,
    ask/reply, completion, exact request replay, and exact stop.
- Findings:
  - These were narrow truthfulness and recovery gaps; none required a scheduler, automatic retry,
    access-control framework, replicated Run database, UI, or provider-session abstraction.
  - The release-contract test failure is already present on `main`; it is separate from this
    orchestration change. The skill round-trip failures were branch-caused and are fixed by
    restoring their committed history.
- Next:
  - Run the complete changed-file quality gates, rebuild the physical Windows dev runtime with this
    final patch, repeat the setup-status slice, then push and recheck PR CI/review state.

### Entry template

```text
### YYYY-MM-DD — Short implementation milestone

- Changes:
  - ...
- Files:
  - `path`
- Verification:
  - command/test and result
- Findings:
  - decision, surprise, or risk
- Next:
  - one concrete next step
```
