# OMP RPC parity — dependency follow-up ledger

This ledger records parity items skipped in the full-parity run because an upstream, runtime, product, host, or tooling dependency blocked them. It also records the renderer-facing UAT item that executed but could not be exercised deterministically.

## Unknown-frame diagnostic rendering and opt-in raw capture

**Phase:** `session-event-projections`

**Evidence:** `src/main/omp-rpc/omp-rpc-client.ts:155-184` preserves unrecognized frames as unknown-frame events; `/Users/rahul/dev/projects/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-types.ts:377` defines only canonical session and subagent event unions and no diagnostic-rendering or raw-capture contract.

**Required dependency / repository change:** Define and land a canonical OMP RPC frame and runtime contract for diagnostic rendering or opt-in raw capture in the upstream RPC types/runtime, then expose that contract to Orca's `src/main/omp-rpc/omp-rpc-client.ts` and `src/renderer/src/components/native-chat/omp-rpc-turn-reducer.ts`.

**Acceptance criteria:** A supported OMP runtime emits a documented diagnostic/raw-capture frame; the canonical source types it; Orca validates and preserves it; and a live or fixture run renders the diagnostic and captures raw payload only when opted in.

**Downstream Orca work unlocked:** Implement typed unknown-frame diagnostics and user-controlled raw frame capture in the client and turn reducer.

## Idle recap update handling and reconnect hydration

**Phase:** `history-hydration`

**Evidence:** `/Users/rahul/dev/projects/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-types.ts:99-103,140-143` and `/Users/rahul/dev/projects/oh-my-pi/docs/rpc.md:301-323` define `RpcRecap`, `recap_update`, and `get_state.latestRecap`; `docs/omp-rpc-chat-adapter-plan.md:211-221` records a complete-turn and idle-window probe with zero recap frames; `docs/omp-rpc-chat-adapter-plan.md:490-496` records that the installed runtime lacks the matching change; a direct `get_state` probe against `omp/18.0.11` returned no `latestRecap` field; the launched binary scan found zero `latestRecap`, `recap_update`, and `idleRecap` strings.

**Required dependency / repository change:** Ship the upstream idle-recap change, including `latestRecap` in `get_state` and `recap_update` frames, in the OMP package/runtime used by Orca; the source change is represented by upstream commit `923ff4e856` in `packages/coding-agent/src/modes/rpc/rpc-mode.ts:1132` and `rpc-types.ts:123`.

**Acceptance criteria:** With a runtime containing the change, a live idle session emits `recap_update`, `get_state` returns `latestRecap`, and reconnect hydration restores the recap through `src/main/omp-rpc/omp-rpc-frame-dispatch.ts`, `omp-rpc-frame-validation.ts`, and `omp-rpc-turn-reducer.ts` without synthesizing absent fields.

**Downstream Orca work unlocked:** Implement and verify idle recap transport, state hydration, and reconnect rendering for RPC-owned sessions.

## Run TUI-only builtins (`/clear`, `/compact`, and peers) on an RPC-owned pane

**Phase:** `command-routing`

**Evidence:** `oh-my-pi/packages/coding-agent/src/slash-commands/available-commands.ts:46-47` omits builtins without `command.handle`; `oh-my-pi/packages/coding-agent/src/slash-commands/builtin-lifecycle.ts:120-128` defines `/clear` with `handleTui` only; `oh-my-pi/packages/coding-agent/src/slash-commands/acp-builtins.ts:65-66` refuses the same commands over RPC. Orca's `src/renderer/src/components/native-chat/omp-rpc-local-command-route.ts` already gates the session route on `isOmpRpcExecutableCommand` and fails closed to the live-terminal notice.

**Required dependency / repository change:** Add text-mode/RPC handlers for the TUI-only builtins in the upstream OMP package, or define and approve an explicit Orca release-to-PTY-and-retype product flow. The preferred dependency is an upstream handler in `oh-my-pi/packages/coding-agent/src/slash-commands/builtin-lifecycle.ts` that is included in the RPC catalog and accepted by `acp-builtins.ts`.

**Acceptance criteria:** The negotiated RPC catalog contains the builtin; executing it over an RPC-owned pane produces the command result without a model turn or PTY fallback; and a live UAT confirms the resulting session state.

**Downstream Orca work unlocked:** Route `/clear`, `/compact`, and the remaining TUI-only builtins through the owning RPC session with correct output and lifecycle handling.

## Fully correlate `command_output` capture

**Phase:** `command-routing`

**Evidence:** `oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:1033` has the single `command_output` emit site and emits only `{ type, text }`; `oh-my-pi/packages/coding-agent/src/slash-commands/builtin-lifecycle.ts:188,289` dispatches `/compact` and `/handoff` in the background and calls `runtime.output` after their command-consumed response. Orca's `src/renderer/src/components/native-chat/use-omp-rpc-command-send.ts:65-66,229-234` serializes commands and retires capture slots, which bounds but cannot eliminate late-output misattribution.

**Required dependency / repository change:** Add a correlation id, or explicit start/end markers carrying the request id, to the upstream `command_output` frame emitted by `packages/coding-agent/src/modes/rpc/rpc-mode.ts:1033`; document and type the field in the OMP RPC contract.

**Acceptance criteria:** A delayed `/compact` or `/handoff` output frame carries its originating request id; a test dispatches two commands across the delay and proves each capture contains only its own output, including after reconnect or response reordering.

**Downstream Orca work unlocked:** Replace the current serialized-slot mitigation with exact frame-to-command correlation and safely support concurrent or background command output.

## Route colon-namespaced non-builtin slash commands against the ACP catalog projection

**Phase:** `command-routing`

**Evidence:** `oh-my-pi/packages/coding-agent/src/slash-commands/helpers/parse.ts:22-36` splits at the first colon and is used by `acp-builtins.ts:63-66`; extension/custom/MCP-prompt/file commands are looked up on the whole token in `packages/coding-agent/src/session/agent-session.ts:6194,6303` and `packages/coding-agent/src/extensibility/slash-commands.ts:122-126`; `packages/coding-agent/src/modes/rpc/rpc-mode.ts:1000-1001,1161` publishes an internal catalog with `source`, while `toAcpAvailableCommands` drops it.

**Required dependency / repository change:** Establish and enforce an OMP version floor whose RPC catalog retains `source`, or add an equivalent canonical field to the ACP projection and its types. The dependency change belongs in the upstream catalog/RPC projection, not in Orca's fail-closed fallback.

**Acceptance criteria:** A live catalog for the supported minimum OMP version identifies builtin versus non-builtin commands; `/deploy:prod` routes according to the published source without treating an extension command as a builtin; and old unsupported hosts are rejected or clearly degraded by a version/capability check.

**Downstream Orca work unlocked:** Implement reliable colon-aware routing for namespaced non-builtin commands without sending them accidentally to the model.

## Remote RPC ownership and `get_messages_page` over SSH/runtime

**Phase:** `remote-locality`

**Evidence:** `src/main/ipc/omp-rpc-chat.ts` resolves `resolveOmpExecutablePath()` locally and calls `getRegistry().acquire({ executablePath, ... })` with no host parameter; `grep -rn "ompRpc" src/main/runtime/ src/relay/` finds no Model-B host method or Model-A relay verb; `src/preload/index.ts` exposes `ompRpcChat:*` only over Electron IPC and `src/renderer/src/web/preload-api/` has no web/runtime bridge.

**Required dependency / repository change:** Add a host-parameterized RPC ownership/history surface beside `src/main/runtime/rpc/methods/native-chat.ts` and/or a relay verb under `src/relay/`, with capability negotiation per `docs/reference/remote-wire-compatibility.md`, so the execution host launches and owns the OMP child.

**Acceptance criteria:** An SSH/runtime worktree can acquire an OMP RPC session on its execution host, stream frames, and call `get_messages_page`; loss of contact reports `unverifiable` rather than `exited`; mixed client/host versions negotiate the feature safely.

**Downstream Orca work unlocked:** Implement remote RPC acquisition, ownership, history pagination, reconnect, and locality-aware renderer integration.

## Breadcrumb session resolution for SSH/daemon panes

**Phase:** `remote-locality`

**Evidence:** `src/main/providers/pty-provider-contract.ts:144` declares `getSlavePath` optional; `src/main/providers/local-pty-provider.ts:74` is the only implementation, with no SSH/runtime provider or relay verb returning a tty path. The missing remote RPC surface also has no place to consume a resolved session id.

**Required dependency / repository change:** Add an execution-host breadcrumb/tty identity API for SSH and daemon panes, and connect it to the host-parameterized RPC ownership surface described above; implement the provider/relay contract with explicit locality and capability negotiation.

**Acceptance criteria:** An SSH/daemon pane returns a stable execution-host tty/session breadcrumb; the resolver maps it to the correct RPC session without consulting local-only paths; unavailable contact remains `unverifiable` and never falls through to local.

**Downstream Orca work unlocked:** Resolve RPC session identity for remote panes and safely bind breadcrumbs to remote history and ownership.

## Loosen `nativeChatRequiresLocalTranscript('omp')`

**Phase:** `remote-locality`

**Evidence:** `src/shared/native-chat-agent-support.ts` documents the failure prevented by the flag; the current RPC bypass is safe only for a pane executed by this client, while a Model-A SSH OMP pane has neither a readable local transcript nor a reachable RPC session. The required remote host surface is absent.

**Required dependency / repository change:** Land the remote RPC host ownership/history surface and its locality/capability contract first; then update `src/shared/native-chat-agent-support.ts` and the renderer gate to allow remote OMP only when a live host-owned RPC session or equivalent readable remote history is proven.

**Acceptance criteria:** Local OMP behavior is unchanged; a remote pane opens Chat only after remote RPC ownership/history capability is confirmed; an unhydrated or disconnected remote pane stays closed or reports `unverifiable` instead of loading indefinitely.

**Downstream Orca work unlocked:** Support native Chat for SSH/daemon OMP panes without admitting a pane that has no transcript or reachable session.

## Recap transport until the installed runtime gains the canonical change

**Phase:** `pty-hook-lifecycle`

**Evidence:** The phase brief declares recap transport out of scope; the installed `omp/18.0.11` runtime emits no idle recap frame, as shown by `strings -a /Users/rahul/.local/bin/omp | grep -c recap_update` returning `0` and the direct `get_state` probe returning no `latestRecap`.

**Required dependency / repository change:** Ship the canonical upstream idle-recap runtime change before adding PTY-hook transport work; specifically make the installed OMP package include the `recap_update`/`latestRecap` contract represented by upstream commit `923ff4e856`.

**Acceptance criteria:** A real supported OMP child emits and validates recap frames during the lifecycle scenarios owned by this phase; the hook can transport those frames without mocks or synthesized fields; and the existing history-hydration checks pass.

**Downstream Orca work unlocked:** Add recap-aware PTY handoff/recovery behavior once there is a real wire signal to transport.

## Hand a terminal back to a pane whose child died with a `protocol-fault` frame

**Phase:** `pty-hook-lifecycle`

**Evidence:** `src/main/omp-rpc/omp-rpc-client.ts` marks the client unusable and rejects pending responses on `protocolFault` but does not kill the child; a protocol fault proves transport failure, not child exit. Releasing the terminal could create two writers if the child remains alive, while respawn/reap requires an out-of-band liveness signal absent from the wire. The round-3 follow-up narrowed the retry window but did not close it.

**Required dependency / repository change:** Add an out-of-band, execution-host-owned liveness/reap signal to the OMP lifecycle contract, or add a protocol capability that proves child exit after a protocol fault, then integrate it with the pane handback/release path.

**Acceptance criteria:** After a protocol fault, Orca can distinguish `live`, `unverifiable`, and `exited`; it releases and hands back the PTY only for proven exit; it never creates two writers for a still-live child; and tests cover contact loss and late child exit.

**Downstream Orca work unlocked:** Complete automatic terminal handback and cleanup for protocol-faulted RPC panes without unsafe respawn or orphaning.

## Global `pnpm` launcher bootstrap

**Phase:** `tooling`

**Evidence:** The canonical `pnpm` launcher failed before running gates with `pnpm: line 4: syntax error near unexpected token`; the run therefore used direct `node_modules` equivalents while recording the canonical commands. This is an environment/tooling failure, not evidence that the canonical gates pass.

**Required dependency / repository change:** Repair or replace the global `pnpm` launcher so the configured pnpm executable bootstraps and runs commands on the supported shell/platform matrix; do not change dependency manifests or lockfiles as a workaround.

**Acceptance criteria:** In a clean shell, `pnpm --version` exits successfully and the canonical `pnpm test`, `pnpm tc:node`, `pnpm tc:web`, and `pnpm exec oxlint ...` commands start without the launcher syntax error; direct fallback is no longer required.

**Downstream Orca work unlocked:** Run the repository's canonical test, typecheck, and lint gates directly and make their results authoritative for parity runs.

## Advisor transcript rendering with primary-transcript deduplication

**Phase:** `subagent-advisor`

**Evidence:** Renderer UAT executed over CDP at `http://127.0.0.1:9333`, but `ev-advisor.json` and `ev-advisor2.json` recorded `advisorCards: []` and `retiredAdvisorTurnIds: []` for every sample; the real `omp 18.1.6` advisor was enabled successfully via `/advisor on` but raised no card across four provoking turns and its catalog exposed no force/emit command. The advisor card therefore never reached the `message_start`/`message_end` carrier needed to exercise rendering or deduplication.

**Required dependency / repository change:** Provide a deterministic upstream OMP advisor test hook, fixture mode, or force/emit RPC command that emits a canonical advisor card carrier in a supported runtime; alternatively provide an approved deterministic fixture/UAT injection contract for the renderer.

**Acceptance criteria:** A renderer UAT can deterministically cause one advisor card to arrive, assert it appears in `turnState.advisorCards` and the transcript, then assert its primary-transcript copy is retired/deduplicated; the existing live advisor path remains covered separately.

**Downstream Orca work unlocked:** Complete end-to-end verification and any remaining fixes for advisor card rendering and primary-transcript deduplication.
