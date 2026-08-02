# Orchestration conversation wake

Orca has a disabled-by-default runtime foundation for waking an Orca-owned control conversation after a supervised Run commits `worker_done`, `escalation`, `decision_gate`, or `question` mail.

## Safety boundary

- `ORCA_FEATURE_ORCHESTRATION_CONVERSATION_WAKE=1` enables the foundation.
- `ORCA_DISABLE_ORCHESTRATION_CONVERSATION_WAKE=1` is the runtime kill switch and is checked before inspection, claim, submission, and acceptance persistence.
- The `codex-controlled` provider is production-shaped but disabled unless all three `ORCA_FEATURE_CODEX_CONTROLLED_LAUNCH=1`, `ORCA_FEATURE_CODEX_CONTROLLED_PROVIDER=1`, and `ORCA_FEATURE_ORCHESTRATION_CONVERSATION_WAKE=1` flags are set. `ORCA_DISABLE_CODEX_CONTROLLED_SESSION=1` or the global wake kill switch stops launch, inspection, acceptance, and submission.
- Existing Codex panes remain unmanaged PTYs. Orca only registers the provider for an explicitly controlled launch; it never upgrades a legacy pane, starts a competing app-server, writes PTY input, or interrupts an active turn.
- Unmanaged PTYs, unsupported providers, missing conversations, and stale Run consumer generations fail closed. This path never writes PTY bytes, submits Enter, or interrupts an active turn.

## Runtime contract

An adapter must prove that Orca owns the provider conversation before calling `bindOrchestrationConversationWake`. A binding records the Run consumer generation, provider, and opaque conversation ID. One active provider conversation can belong to only one Run. Rebinding or moving the Run consumer fences the prior binding and all unsubmitted jobs, then deterministically backfills eligible unread mail for the new generation.

The adapter must implement `ConversationWakeProvider`:

- `getState` returns `idle`, `active`, `missing`, or `unsupported`.
- `prepareAndFinalizeTurn` serializes by conversation and honors the generation-scoped idempotency key. Before calling `commitPrepared`, it must durably prepare the exact turn so a successful callback can always be recovered and finalized after a crash. Recovery requests carry `acceptedTurnId` and must finalize that exact preparation without creating another turn. A rejected callback must produce no provider turn.
- `onTurnTerminal` is mandatory. It notifies the service after an active turn terminates so queued work can reconcile without interruption; providers that cannot register this callback are rejected.

Wake authority comes only from trusted current or compatibility Dispatch, question, or federated commit paths. Those paths persist Task and Dispatch provenance after their own DB and capability reconciliation. Mailbox addresses, sender strings, and payload identifiers never grant authority, so an arbitrary `send` remains wake-ineligible even if it resembles Dispatch mail. The provider receives the persisted identifiers as structured fields, while the fixed prompt contains no payload text or identifiers. It asks the conversation to check the durable mailbox; it does not mark the message read or delivered and does not acknowledge a Run Delivery. If the unread message is consumed before provider acceptance, the job is cancelled.

For eligible local `orchestration.send` events, message insertion, lifecycle reconciliation or worker settlement, and trusted provenance are one SQLite transaction. Any failure rolls back all three; provenance receives the already verified Task and Dispatch lineage directly and never reconstructs authority from message fields.

## Durability

Schema v24 stores bindings, trusted commit provenance, and wake jobs. Job identity includes message ID and Run consumer generation, so remint backfill cannot collide with fenced work. Startup reconciliation scans unread mail carrying trusted provenance before processing jobs, covering a crash between trusted commit and the post-commit hook.

Jobs move through `pending`, `waiting_for_idle`, `retry_wait`, and `submitting`. A successful `commitPrepared` moves the job to recoverable `accepted`; only exact provider finalization moves it to `submitted`. Run remint fences work that has not reached `accepted`, while already accepted preparations remain recoverable and must finalize with their original turn ID. Result mismatches and unrecoverable accepted work become explicit `blocked_inconsistent`; ordinary unsupported work uses `blocked`, and `cancelled` and `fenced` remain terminal. Acceptance leases and retry deadlines survive restart, transient failures use bounded exponential backoff, and service disposal clears retry timers.

## Controlled Codex lifecycle

The controller starts one app-server for the selected conversation with an explicit short `/tmp/ocw-<uid>/<digest>.sock` path, a `0700` parent, and a `0600` socket. It does not use Codex's default control path. A visible `codex resume --remote unix://PATH` TUI rejoins the same running thread, while a separate local WebSocket-over-Unix client observes `thread/read`, `thread/status/changed`, `turn/started`, and `turn/completed` and submits only when `canAcceptDirectInput` is true.

`orca terminal create --worktree <selector> --controlled-codex-coordinator` is the production entrypoint. The CLI sends `terminal.createAgentSession` with explicit `controlledCoordinator: true` Codex intent after rejecting `--command` and `--title`; ordinary `terminal create` requests retain the legacy unmanaged PTY path. The host resolves the worktree, execution host, cwd, command, `CODEX_HOME`, and account from Orca state, and caller overrides that could change controller authority fail closed before spawn.

The controller creates the thread, launches the visible remote TUI, and waits for deterministic `tui-idle` readiness before registration. From that pane, `orca orchestration run-create --objective <text>` or `orca orchestration run-use --id <run_id>` binds the exact stable pane and Run generation. Renderer reload may remint a terminal handle, so the controller resolves the current handle from the stable pane plus PTY/worktree identity before each inspection.

SSH, WSL, relay, folder workspaces, Windows, unsupported app-server responses, missing conversations, and account drift fail closed. Active turns remain queued until a terminal notification triggers reconciliation; there is no force-interrupt or PTY-submit fallback.

Controller shutdown waits for process exit, escalates to `SIGKILL` after a bounded grace period, and removes only the Unix socket inode created by that controller. An unknown pre-existing socket is never removed or competed with. After an unclean Orca crash, that socket is a durable fence: operators must prove the old controller is gone before removing it; Orca does not auto-restart into a possibly competing thread.

Codex 0.145 has no documented `turn/start` prepare/finalize transaction. Orca therefore durably writes an opaque provider operation and exact prompt, commits that operation to the wake DB, and only then calls `turn/start` with a stable `clientUserMessageId`. A lost or error response is reconciled through `thread/read` by that client ID. If no matching turn is visible, the operation stays ambiguous and is never blindly retried.

## Reliability gates

- Unit/integration: `pnpm exec vitest run --config config/vitest.config.ts src/main/codex/codex-controlled-session-manager.test.ts src/main/runtime/orchestration/conversation-wake-service.test.ts`
- Static: `pnpm run typecheck:node`, `pnpm exec oxlint src/main/codex/codex-controlled-session-*.ts src/main/codex/codex-unix-app-server-client.ts`, and `pnpm run check:max-lines-ratchet`.
- Caller-thread protocol smoke remains read-only, disabled by default, and pinned to bare `codex-cli 0.145.0`: `ORCA_RUN_CODEX_CONTROLLED_SESSION_SMOKE=1 node config/scripts/codex-controlled-session-smoke.mjs <thread-id>`. It uses a private temporary transport and removes it only after its app-server exits.
- Fresh visible-TUI smoke is a separate explicit opt-in pinned to bare `codex-cli 0.145.0`: `ORCA_RUN_CODEX_CONTROLLED_SESSION_SMOKE=1 node config/scripts/codex-controlled-session-smoke.mjs --fresh`. It owns a private temporary Unix socket and app-server, starts a thread without a prompt, creates and temporarily focuses one visible terminal in the current worktree through public `orca terminal create`, waits for `tui-idle`, and proves the exact thread remains unmaterialized or has an empty turns array plus the expected transport/home/user-agent identity. Focusing may remint runtime terminal handles while stable panes remain unchanged. The smoke closes only the returned terminal and removes its owned transport only after the app-server exits. It never sends terminal input or calls `turn/start`.
- This is only a protocol plus visible-remote-TUI smoke. It does not exercise the production `--controlled-codex-coordinator` manager/provider path, feature flags and kill switches, command-override reuse, or production cleanup entrypoint. Packaged Orca 1.4.159 currently blocks that end-to-end path with `Timed out waiting for terminal handle after creation`.
- Promotion remains blocked until the packaged terminal-creation blocker is fixed, the production controlled-coordinator entrypoint passes on macOS and Linux for the pinned Codex version, crash/reload handle remint is exercised end to end, and account-switch/kill-switch soak runs remain duplicate-free.
