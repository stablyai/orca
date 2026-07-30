# Preserve active orchestration work across contract updates

Status: implementation validation

Date: 2026-07-28

## Decision

Do not block updates, restart active workers, or revive the retired scheduler.

On first launch after the contract update, atomically adopt the durable
pre-Run graph into one ordinary lightweight Run. Preserve every Task,
Dispatch, message, gate, terminal, PTY, process, worktree, and prompt
identifier. Mark only the pre-update Dispatch attempts as legacy-contract
attempts and accept the exact command shapes already pasted into those
workers through a narrow adapter.

This is state migration plus a per-Dispatch protocol adapter. It is not a
second scheduler:

- the migrated Run owns the preserved graph and coordinator inbox;
- legacy attempts keep their original protocol until they settle;
- every new attempt uses the current protocol, even on a preserved Task; and
- no placement, polling, concurrency, or deadline loop is resurrected.

## User-visible outcome

- The update installs immediately.
- Existing coordinator and worker terminals keep the same process, PTY,
  worktree, prompt, Task ID, Dispatch ID, and history.
- Orca does not inject text, focus a tab, or start a replacement editor.
- The legacy graph appears in an automatically adopted, normal Run instead of
  being stranded in `run_legacy_local`.
- An original live worker with retained launch proof can keep using the
  `heartbeat`, `worker_done`, `escalation`, `ask`, and `check` commands in its
  existing prompt.
- An original live coordinator can keep listing and settling preserved Tasks,
  dispatch remaining work with current commands, check direct legacy mail, and
  use the pre-cutover `reply` CLI guidance.
- Unprovable, stale, ambiguous, or already-settled rows remain inspectable and
  unmistakably read-only. They never advertise Reply or Ack actions.
- A pre-update WSL process whose older launcher did not propagate the hidden
  token remains lifecycle read-only. Its assignment, process, terminal, and
  filesystem work remain valid and inspectable.

The retired `orchestration run`, `coordinator-start`, and `coordinator-stop`
scheduler commands remain retired. Their in-memory loop cannot be reconstructed
truthfully. The coordinator agent and all durable work remain accessible; it
explicitly dispatches any ready work that was never assigned before the update.

## Evidence and constraints

- Schema v7 preserved old `messages`, `tasks`, `dispatch_contexts`, and
  `decision_gates` by assigning them to `run_legacy_local`.
- The exact prompt at `8b154d686` used old `send`, `ask`, and consuming
  `check` shapes. It omitted `worker_done --outcome`; a subject equal to
  `Failed` or beginning `Failed:` represented failure. Its escalation carried
  `taskId` but no `dispatchId`.
- `reply` existed in the old CLI and message formatter guidance, not in that
  pinned worker prompt.
- Restored `OrcaRuntime` PTY records currently set `launchToken: null`, and
  provider `listProcesses()` does not expose the launch token. Handles and
  pane IDs alone therefore cannot authorize compatibility.
- Managed hooks source the owner-only endpoint file on every invocation, so an
  old process reaches the new hook server after restart. The hook cache retains
  the prior authenticated pane/launch-token association and distinguishes
  hydrated rows from events observed by the current runtime.
- Older builds did not propagate `ORCA_AGENT_LAUNCH_TOKEN` through `WSLENV`, and
  a running process cannot acquire it retroactively.
- The CLI transport mutation receipt is keyed by rotating runtime
  authentication. It cannot deduplicate a legacy mutation across restart.
- Current invalid-capability lifecycle sends deliberately remain as auditable
  rejected messages. Compatibility must not silently change that behavior.
- PR #11142 fixes background-tab materialization for newly dispatched workers.
  It does not recover a pre-fix worker whose PTY survived an update after its
  renderer tab binding was lost; workspace activation can otherwise mistake
  that worker for a sleeping provider session and launch `codex resume`.
- The packaged Windows launcher keeps its Electron-as-Node child alive for the
  lifetime of a blocking CLI command. A seamless design cannot assume that a
  bounded RPC wait releases the installed executable.

## Non-negotiable invariants

1. Adoption never spawns, writes, signals, stops, focuses, or injects a
   terminal and never mutates the assigned filesystem. It may restore one
   persisted background tab/leaf binding for the exact already-live PTY.
2. Every durable row and identifier survives adoption; only its owning Run and
   explicit protocol metadata change.
3. Compatibility is write-once per Dispatch. Migration never classifies a
   current retry as legacy.
4. A legacy mutation requires one uniquely resolved legacy attempt or
   coordinator principal plus current live proof of its original process tree.
5. Caller-supplied handles, pane keys, Task IDs, Dispatch IDs, or remote
   attachments never create authority.
6. Current Dispatch behavior remains unchanged, including auditable rejected
   lifecycle messages, capabilities, process incarnation, Run Delivery, and
   question semantics.
7. Legacy direct mail and current Run Delivery are disjoint, even when their
   Dispatches share one migrated Task and Run.
8. A B-era disconnect may replay accepted work; it may not lose mail or create
   a second question, reply, completion, or settlement. A cut after an A-era
   ask was already answered is explicitly ambiguous because A persisted no
   invocation identity; recovery replays its answer through legacy check before
   a same-text question is asked again.
9. Different reply bodies for the same source and principal conflict instead
   of creating multiple replies.
10. Folder workspaces, SSH, WSL, remote runtimes, macOS, Linux, and Windows
    follow the same proof rules. Missing proof degrades to inspection without
    invalidating the retained assignment or filesystem work.

## Storage and atomic adoption

Raise the schema version and add:

```text
dispatch_contexts.contract_version INTEGER NOT NULL
dispatch_contexts.launch_token_hash TEXT
messages.delivery_contract TEXT NOT NULL
  CHECK(delivery_contract IN ('legacy_direct', 'current_delivery', 'audit_only'))
legacy_adoptions(
  source_run_id PRIMARY KEY,
  adopted_run_id UNIQUE NOT NULL,
  scheduler_state_lost INTEGER NOT NULL,
  adopted_at
)
legacy_compatibility_principals(
  id PRIMARY KEY,
  run_id NOT NULL,
  dispatch_id,
  role CHECK(role IN ('worker', 'coordinator')),
  host_scope NOT NULL,
  terminal_handle NOT NULL,
  pane_key NOT NULL,
  launch_token_hash NOT NULL,
  process_incarnation,
  status CHECK(status IN ('committed', 'settled', 'revoked')),
  UNIQUE(role, run_id, dispatch_id)
)
legacy_operation_receipts(
  principal_id,
  operation_key,
  method,
  payload_hash,
  effect_id,
  response_json,
  completed_at,
  PRIMARY KEY(principal_id, operation_key)
)
legacy_mail_receipts(
  principal_id,
  message_id,
  acknowledged_at,
  PRIMARY KEY(principal_id, message_id)
)
```

The schema migration runs in one `BEGIN IMMEDIATE` transaction:

1. create a persisted random Run ID and `legacy_adoptions` marker if one does
   not already exist;
2. create an ordinary `legacy = 0` Run with a recovery objective;
3. move all `run_legacy_local` Tasks, Dispatches, decision gates, messages,
   and question threads to it without changing their IDs, sequence, status, or
   content;
4. mark pre-existing direct mail `legacy_direct` and hard-cutover rejection
   rows `audit_only`;
5. mark a Dispatch legacy only when it predates the contract column and lacks
   a current dispatch capability; and
6. fence any impossible outstanding legacy Delivery, move retained Delivery
   history to the adopted Run, assert every Task/Dispatch/gate/message/question/
   Delivery Run ID agrees, and leave `run_legacy_local` as an empty read-only
   audit tombstone.

Every new Dispatch and message writes the current contract explicitly.
Repeated startup, a partially initialized fixture, and WAL recovery reuse the
persisted adoption marker. Reset and fresh-database paths cannot synthesize
legacy authority.

## Durable principals and live authority

After the hook server and PTY inventory are ready, a one-shot adoption service
may commit compatibility principals. It does not mutate terminal processes or
input.

Before renderer hydration, legacy Dispatch evidence also fences automatic
provider resume for the exact sleeping pane. Once the relevant local daemon or
SSH relay has authoritative inventory, Orca intersects the durable handle,
pane, PTY ID, PTY incarnation, workspace, and host owner. A unique live match
is adopted into its original tab/leaf as inactive background state while the
coordinator tab remains active. Missing, stale, reused, cross-host, or
ambiguous evidence stays fenced and inspectable. Ordinary provider resume is
unblocked only when authoritative inventory proves that exact PTY exited.

At hook-server startup, copy the validated hydrated status rows into an
immutable main-process-only startup snapshot before the server listens or
binds the new listener. Later live events update a separate current-runtime
observation map and cannot overwrite the pre-update commitment source. A
current event is preferred but is not required before the worker's first
post-restart lifecycle command when controller inventory proves the exact
original PTY and process incarnation are live.

For each candidate it resolves the union of:

- durable Dispatch assignee and pane;
- equivalent-pane aliases;
- remote attachment and host ownership;
- coordinator candidates from active legacy coordinator rows, Task creator
  handles, Dispatch coordinator/parent provenance, and direct-message
  sender/recipient history;
- the restored terminal inventory and process incarnation; and
- the hydrated, previously authenticated hook pane/launch-token association.

The candidate commits only when that union identifies exactly one role and
row. The orchestration database stores a SHA-256 token commitment, never the
raw token. The existing owner-only hook status cache is an input to the
one-time commitment, but a hydrated status is not enough to mutate.

Every compatibility call then requires:

- a hidden launch token and pane inherited by the calling process;
- the immutable pre-update hook commitment, plus either a matching
  current-runtime hook event or exact current controller proof of the original
  PTY and process incarnation;
- a live PTY with the committed handle, host scope, and process incarnation;
- the committed principal and exact active legacy Dispatch or adopted Run; and
- an operation-specific unique match.

The current hook event or exact controller inventory proves that the process
survived the restart; equality with the pre-update commitment proves it is the
same launch. If the hook cache was absent, the provider cannot report the
proof, the token changed, or any candidate is ambiguous, the row remains
read-only.

For new Dispatches, persist the launch-token hash at dispatch time so later
contract updates do not depend on hook-cache recovery. Never return or log raw
tokens. Add explicit RPC-envelope, structured-log, error, and CLI JSON
redaction tests.

Host scope is runtime-owned:

- local: stable local execution-host identity;
- WSL: stable native execution-host identity plus distro;
- SSH: saved-host authority plus remote pane/process identity; and
- federated runtime: authenticated peer fingerprint plus remote attachment.

`pickRemoteCliEnv`, SSH relay forwarding, WSLENV, and the legacy in-process SSH
fallback must carry the hidden evidence without exposing it in command text or
logs. A local runtime never accepts a raw remote token as local authority.
Pre-update WSL processes without the token cannot use the lifecycle adapter.

For SSH, the host passthrough and in-process fallback stamp the saved target,
`SshRelaySession` connection incarnation, and attachment provenance from the
authenticated runtime channel; caller environment cannot choose them. WSL
stamps the runtime-owned native host and distro in both the full bridge and
fallback bridge. The verifier intersects those stamps with the committed host
scope before considering token or pane evidence.

## Mixed-contract Run and mail routing

The adopted Run is a normal current Run. Tasks belong to it, so a current retry
of a preserved Task naturally routes to the same Run without a cross-Run Task
reference.

Message delivery is selected by `messages.delivery_contract`, not by Run ID:

- old and adapter-created direct messages are `legacy_direct`;
- current sends are `current_delivery`; and
- migration rejections and non-actionable history are `audit_only`.

Current Run Delivery creation, filtering, waiting, and acknowledgment select
only `current_delivery`. Legacy `check` selects only the exact principal's
`legacy_direct` address. History and inbox may show all three with explicit
labels but never attach actions to `audit_only`. Mixed legacy/current attempts
under one Task are covered across send, ask, check, reply, and settlement.

The original coordinator is automatically associated with the adopted Run
after its principal proves live. `run-use` may bind that same principal without
converting legacy Dispatches. A different coordinator cannot silently take
over while a legacy attempt is active; an explicit recovery takeover is a
separate current-contract action and revokes legacy coordinator mutation
authority before rebinding.

When that coordinator uses old direct `check`, the adapter also performs a
non-consuming existence check for `current_delivery` mail. It never mixes the
messages into legacy output; it prints the exact current Run check command and,
after that command creates a Delivery, the exact acknowledgment form. This
keeps an unchanged coordinator informed about current retries without
weakening current Delivery semantics.

## Exact legacy adapter

The CLI keeps accepting the old flags. It sends a hidden compatibility
envelope; the runtime, not the CLI, decides whether legacy behavior applies.

Version B generates a random hidden `compatibilityInvocationId` once per CLI
process and reuses it for every transport reconnect by that invocation.
`legacy_operation_receipts.operation_key` is this invocation ID for B calls.
The method and canonical payload hash must also match.

Attested compatibility calls bypass the rotating-auth generic mutation ledger
after the contract fence routes them to the adapter. Their only dedupe boundary
is the compatibility-principal receipt transaction described here; current
calls continue through the existing generic ledger unchanged.

Version A had no invocation ID. Cross-cutover reconstruction is therefore
limited to effects with a durable semantic identity: final settlement per
Dispatch, still-pending ask per normalized question/options/recipient, reply
per source/principal/body, and read recovery per message. Heartbeat and
escalation remain at-least-once across an A-to-B manual retry because
collapsing identical commands could suppress a legitimate later event. Tests
and guidance do not promise cross-cutover exactly-once behavior for those
repeatable signals.

An A-era ask that was already answered before its output was lost is also
ambiguous. B does not guess whether the same text means retry or a new
question. Its answer is in the durable recovery cohort and the error tells the
agent to run the exact legacy check command first. After that answer is printed
and acknowledged, a new B invocation with identical text creates a new
question. If multiple identical A threads exist, ask fails ambiguous and
recovery check drains them by message sequence; no arbitrary thread is chosen.

### Lifecycle `send`

- `heartbeat` and `worker_done`: resolve Task + Dispatch from the payload, then
  intersect them with the verified worker principal.
- `escalation`: resolve Task + verified worker principal to exactly one active
  legacy Dispatch because the old prompt supplied no Dispatch ID.
- Preserve the old direct coordinator recipient after verifying it belongs to
  the adopted Run principal.
- Infer missing `worker_done` outcome as `failed` only when the trimmed subject
  is `Failed` or begins `Failed:`; otherwise infer `succeeded`.
- Normalize to the current internal settlement model.

Compatibility validation happens before message insertion. Current lifecycle
handling is not refactored through this prevalidation: its existing
invalid-capability audit message behavior remains locked by regression tests.

The DB commits the direct message, lifecycle effect, and compatibility receipt
in one transaction. If a pre-update `worker_done` already settled the Dispatch,
the adapter reconstructs the matching semantic receipt from the existing
message and settlement. The persisted A settlement is authoritative: the
pinned A reconciler recorded even a `Failed:` subject as completed, so B
returns that original completed result rather than retroactively changing Task
or dependency state. Only a not-yet-accepted B call applies the corrected
failure inference. A conflicting retry fails.

### `check`

Legacy check is at-least-once:

1. a read RPC returns the exact unacknowledged `legacy_direct` message IDs
   without changing them;
2. the CLI prints the complete response; and
3. a hidden ack atomically records receipts and marks those exact rows read.

A cut after read and before ack replays the same IDs. `--peek` and `--all`
remain read-only.

Version A could mark a message read before losing its response. On adoption,
every eligible read direct message connected to a still-active legacy attempt
and lacking a post-adoption receipt is inserted into a durable recovery cohort
using `legacy_mail_receipts` with `acknowledged_at = NULL`. Legacy check drains
that stable cohort in bounded sequence-ordered pages before ordinary unread
mail. Each page is labeled
`[LEGACY RECOVERY REPLAY — MAY HAVE BEEN SEEN]`, replays until its post-print
ack, and then advances. The cohort never grows after adoption, so every
eligible row is covered without an unbounded response. Settled-at-cutover and
unrelated historical mail do not enter it.

### `ask`

Legacy ask is an idempotent mutation followed by a resumable read:

1. create or find the direct legacy gate/question by verified Dispatch,
   normalized question, options, and recipient;
2. atomically commit its message/thread plus operation receipt and return the
   stable question ID;
3. wait in bounded read-only slices using that ID; and
4. after printing the answer, hidden-ack that exact answer.

On first adoption, existing pending decision-gate threads are indexed into the
same semantic identity. A retry resumes them instead of creating another gate.

### `reply`

Legacy reply requires the source thread, the verified coordinator principal,
and a unique question owned by the adopted Run. One transaction inserts the
reply, resolves the exact gate, marks the exact source, and completes the
receipt.

An existing pre-update reply with the same source, principal, and body is
reconstructed as success. A second body for the same source/principal is a
conflict, not another reply.

### Coordinator and Task commands

After automatic binding, unchanged Task listing, Task settlement, dispatch,
and gate inspection use the adopted Run. A new attempt receives a current
preamble, capability, launch-token commitment, and current message contract.
No unrelated Task can be created until the migrated coordinator binding is
proven or explicitly taken over.

## Windows update behavior

No compatibility mutation holds a DB transaction while waiting. Windows
legacy `ask` commits the question, prints its stable ID and exact resume
command, then exits before a long wait whenever the installed launcher cannot
prove that the executable is replaceable.

The native packaged launcher sets an internal
`ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER=1` marker for its Electron-as-Node child.
After the DB commit, legacy `ask` writes and flushes the stable question ID and
the exact resume command, then exits with a documented `75` resume-required
status. The command name comes only from the validated inherited
`ORCA_CLI_COMMAND` packaged enum: `orca` for native packaged terminals or
`orca-ide` for packaged WSL. Arbitrary environment text is rejected rather
than rendered. The launcher propagates status 75. No long wait starts on this
path.

This compatibility path makes the accepted question recoverable without
claiming Windows updater or uninstaller process ownership. Generic executable
drain, replacement, and uninstall behavior remains separate updater
reliability work and requires its own Windows artifact proof.

## Rendering and authoritative guidance

Formatting is authority-aware:

- `[LEGACY COMPATIBILITY]`: live and attested; show only supported commands;
- `[LEGACY RECOVERY REPLAY — MAY HAVE BEEN SEEN]`: one bounded cutover replay;
- `[LEGACY READ-ONLY]`: retained but unactionable; no Reply or Ack hint; and
- current messages: unchanged.

Update `skill-guides/orchestration.md` and regenerate its bundled source. The
guide explains automatic adoption, exact continuity, the retired scheduler
boundary, proof failures, current retries, and the Windows ask resume fallback.
It must not tell agents to restart a worker whose Dispatch was adopted.

Formatting cannot use database provenance alone; current liveness and
attestation are runtime facts. Recovery may reveal the exact already-live PTY
once as an inactive background tab. It never creates a PTY or process, writes
input, switches workspaces, focuses, splits, or injects a terminal.

## Deterministic verification

### Schema and authority

- Migrate exact pre-v7, hard-cutover, current, partial, WAL, reset, and fresh
  fixtures; preserve IDs and row counts and reuse one adopted Run.
- Assert Task, Dispatch, decision-gate, message, question-thread, and retained
  Delivery Run ownership agrees; outstanding legacy Deliveries are fenced.
- Prove current retries in the adopted Run remain current across repeated
  migrations.
- Test unique worker/coordinator import from prior hook commitment plus current
  live hook, and every forged, stale, wrong-host, wrong-pane, wrong-process,
  duplicate-token, duplicate-role, equivalent-pane, and remote-attachment
  ambiguity.
- Race a current-runtime hook before adoption and prove the immutable startup
  commitment is neither overwritten nor confused with live proof.
- Cover manual coordinators with no `coordinator_runs` row and reject
  conflicting candidates from Task, Dispatch, and message provenance.
- Assert all legacy authority failures occur before message/receipt/gate/state
  effects while current invalid-capability rejection remains unchanged.
- Assert tokens are absent from RPC logs, errors, CLI output, and orchestration
  storage.

### Exact old behavior and replay

- Replay the pinned prompt's heartbeat, successful and `Failed:`
  `worker_done`, task-only escalation, ask, and consuming check.
- Replay the old formatter's reply command separately.
- Cover every operation once after B and once accepted by A immediately before
  the cutover where a durable semantic identity exists, including the bounded
  recovery replay for an A check and preservation of A's persisted settlement.
- Prove one B invocation reuses its invocation ID across reconnect, while
  separate identical heartbeat/escalation invocations remain distinct.
- Inject real transport cuts after check read, ask commit, reply commit, and
  completion commit; prove stable IDs and one receipt/effect.
- Page a recovery cohort larger than one response limit across repeated
  disconnects and prove every eligible row appears until ack, then never again.
- Test mixed legacy/current attempts for every send/check/ask/reply route and
  prove current Delivery cannot consume legacy direct mail and old coordinator
  check only advertises the exact non-consuming current Delivery command.

### Live two-launch E2E

The focused renderer/daemon restart regression reconstructs the rc.3-era
orphan artifact in a shared candidate profile: a durable legacy Dispatch,
sleeping provider record, and live daemon PTY with its visual binding removed.
It proves startup restores the exact PID, PTY/incarnation, handle, tab/leaf,
Task, and Dispatch; emits no provider-resume spawn or interruption; preserves
coordinator focus; and remains inert after switching away and back. This
candidate/candidate fixture covers the renderer regression deterministically
but does not replace the distinct installed-A/candidate-B packaged cutover
journey below. It does not claim packaged Windows updater behavior.

Use distinct installed A and B artifacts plus an external append-only fake
agent spawn ledger:

1. launch A with coordinator and worker terminals and record the replaceable A
   desktop/main PID, runtime ID, version, and artifact hash separately from the
   durable daemon, coordinator, and worker identities;
2. accept one command with durable semantic identity on A—pending ask, reply,
   completion, or check—cut its response, close A without stopping the daemon
   or fake agent, install B, and prove B owns the relaunched runtime;
3. assert A's desktop/main process and runtime are gone, B has a different
   desktop/main PID, runtime ID, version, and artifact hash, while the daemon
   plus coordinator/worker PID and start time, PTY/session, terminal handle,
   tab/leaf/pane, worktree, Task, and Dispatch remain byte-identical;
4. prove that exact pending ask, reply, completion, or check resumes or
   deduplicates on B; do not use heartbeat, escalation, or an already-answered
   A ask as an exactly-once oracle;
5. run the remaining exact old lifecycle commands and settle the same
   Dispatch;
6. switch away and back and assert no second spawn/tab and no
   `Conversation interrupted`; and
7. create a current attempt on preserved state and prove current grammar.

The append-only spawn ledger and an append-only interruption ledger, daemon
inventory, runtime terminal inventory, and every viewer DOM independently
prove one launch, process, handle, tab, and no `Conversation interrupted`.
Transport fault injection cuts the real CLI connection after check output but
before ack, and after ask, reply, and completion commit. Re-run the byte-exact A
argv under B and assert stable IDs plus exactly one message, gate, reply,
settlement, and receipt.

Retain #11142's local visible-inactive test and extend its oracle beyond DOM
counting with the ledgers and host inventory.

Run separate remote journeys:

- headed paired server A-to-B with a surviving external client;
- headless `orca serve` A-to-B with the same surviving-client oracle;
- both prove the remote PID/PTy continuity, both viewer states, zero
  client-local handles/tabs, and wrong-host evidence with zero effects;
- Docker SSH restart/reconnect with a remote proof file binding the process,
  pane, and token commitment;
- physical Windows WSL coverage proving the correct distro and rejecting a
  wrong-distro token; and
- a git-independent folder workspace parameter through the same adoption
  journey.

Packaged Windows updater continuity is outside this migration gate. A separate
updater change must prove candidate-built A/B install, executable release,
resume, and normal uninstall behavior on Windows before making that guarantee.

## Implementation slices

1. Schema, atomic Run adoption, per-row contract provenance, and mixed mailbox.
2. Hook-commitment import, live principal verifier, host scopes, and redaction.
3. Atomic compatibility receipts plus lifecycle send/escalation.
4. Check read/ack and cutover recovery replay.
5. Ask create/resume, reply conflict semantics, and coordinator binding.
6. CLI hidden envelope, SSH/WSL forwarding, Windows resume fallback.
7. Authority-aware formatting and the version-matched orchestration guide.
8. Two-launch, remote, platform, and #11142 regression coverage.
9. Focused unit/type/lint/E2E checks and final adversarial review.

## Definition of done

- Updates are never blocked.
- Every durable legacy Task is owned by an ordinary visible Run.
- Every provably original live legacy Dispatch can finish through its existing
  prompt without changing process or worktree.
- New attempts use the current contract and mailbox in that same Run.
- No authority comes from IDs or handles alone.
- No adoption step starts, stops, writes, signals, focuses, splits, or injects
  a terminal. Exact live-PTY recovery may restore one inactive background
  renderer tab/leaf binding.
- B-era disconnects replay or deduplicate instead of losing or duplicating
  work; A-era repeatable signals and already-answered asks follow the explicit
  ambiguity recovery rules.
- Lost scheduler memory is reported precisely without stranding durable state.
- Local/background, remote, SSH, WSL, folder, and Windows guarantees have
  deterministic proof.
- The PR contains this plan, focused implementation, and no unrelated changes.
