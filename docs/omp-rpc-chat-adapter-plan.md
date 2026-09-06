# OMP RPC Chat adapter — working plan and state

Tracking issue: [stablyai/orca#10099](https://github.com/stablyai/orca/issues/10099)
Branch: `feat/omp-rpc-chat-adapter` (fork `rhlsthrm/orca`)

## Goal

Make Orca's Chat UI a real OMP JSONL RPC v2 client, as the first built-in
`input:"rpc"` / `transcript:"rpc"` structured agent adapter described in #10099. Orca
already ships the workspace shell and an OMP *transcript-tailing* Chat UI; the missing
load-bearing piece is protocol-faithful RPC, which is what unlocks streaming turns,
RPC-native questions/approvals, and extension UI.

Exit criterion is **full OMP parity**, delivered as a single full-parity PR, plus hands-on
UAT. Partial-parity PRs are explicitly not the plan.

## Source of truth

`src/shared/omp-rpc-protocol.ts` is the wire contract in code — prefer it over any prose.
This document records only decisions and live-probe facts that code does not carry.

## Shipped (this branch, oldest first)

| Commit | Content |
|---|---|
| `c6c94e922` | Shared RPC v2 wire contract + client interface |
| `35584140d` | Probe exposed over IPC (`ompRpc:getCommands`, `ompRpc:runLocalCommand`); `src/shared/omp-rpc-ipc-contract.ts` |
| `3d1b0d227` | Live catalog in composer; `/usage` routed off PTY to RPC, rendered with a "local command — agent not invoked" marker |
| `e91703bb6` | RPC v2 client: spawn, framing, ready validation, negotiation, strict chunk reassembly, correlation, scripted fake child (16 tests) |
| `5a14213e3` | Executable resolver — see "Traps" below (7 tests) |
| `aba1a9214` | Env-gated live probe against the installed `omp` (`ORCA_OMP_RPC_LIVE=1`) |
| `763add4d4` | Registers OMP `session_start` across four gates; also fixes a latent `prime-agent` drop |
| `a818b1d02` | Exclusive session ownership + proof-gated RPC↔PTY handoff (61 tests) |
| `8bb585d97` | **Wave 1.** Turn-lifecycle frames, extension_ui_request/response, steer/follow_up; `OmpRpcChatSession`/`OmpRpcChatSessionRegistry` (per-pane RPC ownership via `OmpRpcSessionOwner.handoffFromPty`); `ompRpcChat:*` IPC surface (acquire/release/send/abort/respondExtensionUi + subscribe push channel) |
| `9d569c481` | **Wave 1.** `ompRpcChat` exposed through preload (`src/preload/api/omp-rpc-chat-api.ts`) |
| `88d0af8e4` | **Wave 1.** `rpc` NativeChatSource; `omp-rpc-turn-reducer.ts` — pure reducer building the in-progress-turn overlay + one-pending-plus-queue extension-ui tracking. Verified live (omp 18.0.6): RPC message-in-progress frames carry no id matching any transcript entry, so RPC content is never id-merged (D4) — it renders as a leads-gated overlay instead, generalizing the hook-preview "leads" suppression so double-rendering a turn is impossible by construction |
| `c6e923344` | **Wave 2.** `use-omp-rpc-chat-session.ts` binds a pane to the acquired session (acquire/subscribe/release lifecycle, leak-free on unmount/view-away/pane-close/identity-rebind); `use-native-chat-omp-rpc-integration.ts` composes it into the overlay/status projections the view needs |
| `c22913b1a` | **Wave 2.** `NativeChatExtensionUiCard.tsx` — select/confirm/input/editor rendering for `extension_ui_request` (D7) |
| `9e2af8bb7` | **Wave 2.** `use-omp-rpc-chat-send.ts` + composer wiring — chat prompts route through the RPC session before the PTY fallback (D6); "Follow up" affordance |
| `ca83db743` | **Wave 2.** `NativeChatView.tsx` wiring — RPC overlay spliced into the message list, D5 status override, extension-UI card swap, Stop routed through `abort()` |
| `fcb5180aa` | **Wave 3.** Repairs 12 defects found by two independent adversarial reviews (same-lab Opus 5 + cross-lab GPT-5.6), each with a regression test. Two were critical: (a) `parseOmpRpcMessageUpdateFrame` faulted on the documented user-echo `message_update` (no `assistantMessageEvent`), latching `hasProtocolFault` and killing the session on the *first* prompt; (b) `isOmpRpcTurnActive` was content-derived, so it stayed true after every completed turn — permanent Stop button and a jammed suppression reset. Also: `exit`/`protocol-fault` now degrade the pane to PTY (D1) instead of no-oping behind a false comment; `disposeAll` disposes clients and releases claims so app-quit cannot orphan a second writer (D2); acquire/release serialized per pane with generation-guarded stores and a bounded `conflict` retry (fixes the 15s-release window and the StrictMode double-mount); extension-UI cards always offer cancel and never promote an option-less `select` (D7); fail-closed IPC rejection handling; per-block overlay gating keyed by `toolCallId` (D4); overlay text/tool-output/block-count caps; dead resume-launch fields dropped |
| `7c5d76fa0` | **Wave 3.** Mocks the `omp-rpc-chat` registrar in `register-core-handlers.test.ts` — wave 1 added `registerOmpRpcChatHandlers()` to `registerCoreHandlers()` but not the matching sibling mock, so the real module ran and tripped the suite's `electron` mock (absent `ipcMain`). The only genuine regression the full sweep caught |
| `24f667bb8` | **Wave 4.** Optional `IPtyProvider.getSlavePath`, local-provider-only — a read-only `readPtySlavePath(ptyProcesses.get(id))` delegate needed to derive OMP's own terminal-id |
| `977f71e87` | **Wave 4.** `omp-terminal-session-identity.ts` — Part A: resolves an OMP pane's session identity from OMP's own on-disk state (terminal breadcrumb, then newest-by-mtime cwd bucket), bypassing the broken hook chain (Decision 2). Every path is verified to exist before being returned (13 tests) |
| `5f5a90a28` | **Wave 4.** `ompRpcChat:resolveSessionIdentity` IPC handler wraps the resolver for the renderer, local-only, fail-closed |
| `640cfbc49` | **Wave 4.** `omp-rpc-chat-handback.ts` — `respawnPtyForOmpRpcChatHandback` spawns `omp --resume <id>` (existing `buildAgentResumeStartupPlan` resume path) and rebinds it into the exact pane that released RPC ownership, replacing the old ptyId, reusing the same store primitives `codex-detached-pane-restart.ts`'s in-place respawn uses |
| `2921d8437` | **Wave 4.** `use-omp-pane-session-identity.ts` resolves via the new IPC once a pane is visible (F9-style latch); wired into `NativeChatView.tsx` in place of the hook-derived `sessionId` feeding the RPC integration |
| `035522c5c` | **Wave 4.** Decision 1: `use-omp-rpc-chat-session.ts` kills the pane's live PTY before acquiring instead of only ever finding one already exited, and a new deferred, settle-gated hand-back effect (separate from the acquire effect, so F9 holds unchanged for it) releases + respawns once any in-flight turn settles, canceling if the pane returns to Chat view first |
| `8747bdbcb` | **Wave 5.** Shared IPC contract: `OmpRpcChatReleaseArgs.respawn` (hand-back intent) and the new `ompRpcChat:handback` push payload |
| `c044f34af` | **Wave 5.** Critical A fix: `killPtyBeforeOmpRpcAcquire` suppresses the pty exit (armed, not self-consumed) and proactively clears the tab's pty binding before killing. Critical B fix (renderer half): the unreachable settle-gated hand-back effect is removed; the acquire effect's cleanup/cancelled-before-acquired paths express hand-back intent via `release({ respawn })` and return immediately |
| `0eeed8186` | **Wave 5.** `handoffToPty`'s abort-on-streaming becomes an explicit opt-in (`allowAbort`, default false/unset) — no caller sets it true; default behavior waits (bounded) for a streaming turn to settle and fails closed if it doesn't |
| `393e51f7a` | **Wave 5.** `performRelease` only tears down and reports `released:true` on `handoffToPty`'s `'exited'` path — any other result fails closed (`released:false`), keeping the claim. Registry also tracks each pane's claimed session file path, exposed via `claimedSessionFilePaths()` (finding C's exclusion set) |
| `5b9cc9bee` | **Wave 5.** `omp-terminal-session-identity.ts` hardening: cwd normalization (realpath + trailing-slash strip, finding D) before breadcrumb/bucket comparison; `claimedSessionFilePaths` excludes another live pane's session from the mtime fallback (finding C) |
| `ab67e6711` | **Wave 5.** `ompRpcChat:release` pushes `ompRpcChat:handback` to the requesting sender once a respawn-intent release genuinely settles+exits; `use-omp-rpc-chat-handback-listener.ts`, wired into `TerminalPane` (stays mounted underneath `NativeChatView` through a "leave Chat view" unmount), performs the actual PTY respawn via the unchanged `respawnPtyForOmpRpcChatHandback`. Also wires finding E (`resolveSessionIdentity` verifies pty locality before scanning local disk) and finding C's exclusion set |
| `b6627f37d` | **Wave 6.** W6-1: fixes the turn-completion flicker — `selectOmpRpcOverlayMessages` no longer gates fade-out on the binary `working` flag (a terminal `agent_end` has no debounce; the transcript path has a 150ms filesystem-watcher debounce plus IPC plus a re-render, so the old gate blanked the just-finished reply and reflowed it back in). `nativeChatOverlayLeadsTranscriptContent` (native-chat-streaming.ts) is the content-only comparison the RPC overlay now uses directly; `working` stays the D5 status/Stop signal only |
| `a14b816f8` | **Wave 6.** W6-2: re-scopes RPC ownership (Decision 1) from the Chat-view mount to the pane's life. `use-omp-rpc-chat-session.ts` becomes `use-omp-rpc-chat-pane-ownership.ts`, mounted once in `TerminalPane` (which already stays mounted through the Chat-view unmount for the handback listener) instead of inside the (un)mountable `NativeChatView`. It composes the Decision-2 identity resolver on the same lifecycle and publishes status/turnState into a new `ompRpcChatOwnershipByPaneKey` store slice (mirrors `agentStatusByPaneKey`); `NativeChatView`/`use-native-chat-omp-rpc-integration.ts` becomes a pure remountable subscriber — `send`/`abort`/`respondExtensionUi` are now paneKey-scoped store actions, not hook-instance callbacks. Every prior guard (F9 latch, F5 generation/StrictMode, cancelled-before-acquired, bounded conflict retry, suppressPtyExit-before-kill left armed, `allowAbort` false, D1 fail-closed degrade) carries over unchanged; release now fires only on identity rebind, pane/tab close, or app quit — never a bare Terminal<->Chat toggle |
| (wave 7) | **Wave 7.** First live UAT against a real OMP pane, and its two bugs. Bug 1 (empty pane after acquisition): `ompRpcChatOwnershipByPaneKey` gains a sticky `resolvedSessionId` (Decision 2's identity, published once known and never cleared by later ptyId churn); `NativeChatView`/`native-chat-pane-resolution.ts`'s new `resolveEffectiveNativeChatSessionId` prefers it over the still-broken hook chain (open item 2) for the transcript read and the command-marker cache scope. D1 hole closed in `use-omp-rpc-chat-pane-ownership.ts`: a failed acquire *after* the kill now calls `respawnPtyForOmpRpcChatHandback` directly (the registry-mediated `release({respawn})` path no-ops when nothing was ever acquired, so it never fires the handback push), instead of leaving the pane with neither a terminal nor a session. Bug 2a (reasoning flattened into plain text): `decodeOmpTranscriptLine` now splits a `thinking` content block into a separate `role: 'reasoning'` message ahead of the reply, matching the RPC overlay's existing role-based model; `TranscriptDecoder`/`NativeChatLineDecoder` widen to `NativeChatMessage \| NativeChatMessage[] \| null` across every read/tail/incremental/orchestration decode path, each one normalizing the split (the tail reader — the one the live chat view actually reads through — pushes a split line's messages in *reverse* order since it walks newest-line-first and reverses the whole accumulated list exactly once at the end). Bug 2b (recap): live-probed (`omp-rpc-live-recap-probe.test.ts`, `ORCA_OMP_RPC_LIVE=1`) — the recap never crosses the RPC wire across a complete real turn (18 frames, `agent-start` through `agent-end`, including an observed `advisor_cost_changed` frame); recorded as a ceiling below, not faked. Bug 2c (advisor transcript) scoped out this wave — justification in Open work item 2c below. |
| `5a313cbaf` | **Wave 8.** Fixes the blocking bug that made the RPC chat feature unusable on its own happy path: `NativeChatComposer.tsx`'s `[hasPty, disabled] = [targetPtyId !== null, targetPtyId === null \|\| !canSend]` disabled the whole composer (textarea, send, placeholder) whenever `targetPtyId` was null — which Decision 1 acquisition *always* makes it on success, since it kills the pane's PTY. `hasSendRoute = hasPty \|\| ompRpcChat.isOwned` replaces the PTY precondition everywhere the composer decides whether it can send at all; PTY-only affordances (image attachments) get their own `attachDisabled = !hasPty \|\| !canSend` so they gate individually instead of re-disabling the whole composer. The placeholder ("No live terminal — toggle back to reconnect.") now reads on `!hasSendRoute`, not `!hasPty`, so it stops lying about an RPC-owned pane's actual state |
| `b58ea0b8c` | **Wave 8.** A second, deeper instance of the same bug: `useNativeChatComposerSend` and `useNativeChatPickerCommandDispatch` both resolved `resolveTarget()` and returned on `!target` *before* ever trying `sendOmpLocalCommand`/`sendOmpRpcChat`, so wave 2's RPC send route was unreachable code on exactly the pane state Decision 1 produces — the `disabled` fix above made the composer's UI enabled, but every send still silently no-op'd underneath it. Reordered so the RPC-eligible attempts run first and PTY-target resolution happens only for what's left; the residual PTY-only cases (a slash command outside the `/usage` allowlist, or an image attachment — RPC send stays text-only this milestone) get a `setNotice(...)` instead of silently doing nothing |
| `6fc050a58` | **Wave 8.** `useNativeChatComposerAttachments`'s no-PTY case had been folded into the same notice as an unsupported remote pty ("Local attachments are not available for remote sessions"), which is false for a local, RPC-owned pane with no PTY at all — split into its own honest message |
| `a0563d246` | **Wave 9.** First live UAT of an actual pane's identity/ownership lifecycle exposes two live bugs (Defects 1 & 2). Defect 1 fix, part 1: `resolveOmpPaneSessionIdentity`/the `ompRpcChat:resolveSessionIdentity` IPC handler accept an optional `ptyId` — Decision 1's acquisition kills the pane's PTY on success, so a live `ptyId` was never a legitimate precondition, only an optional accuracy input that unlocks the breadcrumb path over the mtime fallback. `paneKey` is threaded through the same call so the mtime fallback's already-claimed exclusion set can be scoped per-asker (Defect 2 below). Registry's `claimedSessionFilePaths()` becomes `claimedSessionFilePathsExcluding(paneKey)` |
| `8d01c7305` | **Wave 9.** Defect 1 fix, part 2: `use-omp-pane-session-identity.ts` keys its resolution cache on `paneKey`+`cwd` instead of `ptyId`, drops the `ptyId!==null` eligibility gate, and makes resolution sticky (a later re-resolution can confirm an already-resolved id, never downgrade it to null or swap it for a different one) |
| `b19ee822f` | **Wave 9.** Defect 1 fix, part 3 (the actual deadlock trigger): `use-omp-rpc-chat-pane-ownership.ts` duplicated the same `ptyId!==null` gate in its own `identityEligible`/F9 latch key, so even with the identity hook fixed, the acquire/hold effect tore ownership down the moment its own kill nulled `ptyId` — acquire succeeds, PTY dies, ownership resets to `idle`, composer disabled forever (proven live). Keys eligibility on `paneKey`+`cwd`+`sessionFile`; `ptyId` is still required to start acquiring (real kill target) but a live `engagedIdentityRef` keeps eligibility once acquisition has genuinely begun, and the effect's own dependencies no longer include raw `ptyId` so it never re-fires from its own kill. Same fix applied to `isOmpRpcChatSessionEligible`, the exported pure gate |
| `67234f571` | **Wave 10.** `clearTerminalLayoutPanePtyId` — a new store primitive deleting a leaf's stale `terminalLayoutsByTabId[tab].ptyIdsByLeafId` entry, guarded on the id still matching so a race that already rebound the leaf is never clobbered. `clearTabPtyId` never touched this map; a leaf could keep advertising a pty id whose process was already gone |
| `a9cca6315` | **Wave 10.** Live UAT (dev build, CDP) bug: toggling to Chat a second time after a successful hand-back left a dead pane (no PTY, no RPC child) — `use-omp-rpc-chat-pane-ownership.ts`'s restore-on-acquire-failure call (wave 7) sat AFTER the generation-supersede check, so a run whose kill genuinely happened but whose own acquire settled only after a later run had already started for the same identity skipped restoring the PTY it killed. Moved the restore attempt before that check (restoring a specific killed ptyId can never race a different generation's own kill/restore of a different one, superseded or not); retried once (`respawnPtyWithRetry`, same shared-failure-cause reasoning as F5's conflict retry); `killPtyBeforeOmpRpcAcquire` now also calls `clearTerminalLayoutPanePtyId` alongside `clearTabPtyId`. Full spawn-before-kill reordering was assessed and not implemented — `OmpRpcSessionOwner.acquire()`'s spawn is gated behind `handoffFromPty()`'s exit-proof, a hard precondition on this call site, not a reorderable choice; decoupling them needs a two-phase spawn-then-adopt IPC protocol, out of this wave's scope |
| `969daa3d2` | **Wave 11.** Live UAT: after an acquire-failure restore, `tab.ptyId`/`ptyIdsByLeafId[leafId]` correctly showed the restored pty (wave 10 holds), yet the composer still reported "No live terminal" — `TerminalPane.tsx`'s `chatPanePtyId`/`chatOwnerPtyId` (the only source for the composer's `targetPtyId` and for `useOmpRpcChatPaneOwnership`'s `ptyId` input) read exclusively from the pane's connected `PtyTransport`, which `respawnPtyForOmpRpcChatHandback` never rebinds — a fourth one-sided pty-binding site, in the transport rather than the store. `native-chat-effective-pty-id.ts`'s `resolveEffectiveChatPanePtyId` prefers the transport's own live binding and falls back to the store's layout binding, one helper backing both call sites |
| `b63d72f5a` | **Wave 12.** Live UAT (CDP, real reasoning turn): the reasoning overlay never retired against the transcript, so a settled turn's thinking prose rendered AFTER the answer and stayed forever, even long past `turnState.status === 'idle'`. `selectOmpRpcOverlayMessages`'s reasoning gate compared `state.reasoningText` against `nativeChatOverlayLeadsTranscriptContent`, which measures the last **assistant**-role transcript text — thinking prose never matches an assistant reply, so the compare stayed "leading" forever. New `nativeChatOverlayLeadsTranscriptReasoning` (`native-chat-streaming.ts`) compares against the transcript's own `role: 'reasoning'` row (the wave-7 decoder split) instead, scanning back from the end and stopping at the first `role: 'user'` row (the current turn's optimistic-echo boundary) so a stale reasoning row from an earlier turn is never matched |
| `3a4778a4f` | **Wave 12.** Live UAT found a `role: 'reasoning'` row reads as an unlabeled second paragraph of assistant prose despite the border/italic de-emphasis — no affordance identifies it as reasoning. `NativeChatMessageList.tsx`'s `MessageRow` gains a quiet, non-italic 11px uppercase "Reasoning" caption above reasoning rows only, using the existing meta-label token pattern (STYLEGUIDE 11px uppercase caption, `muted-foreground`) |
| `0082f76fc` | **Wave 12 live re-test.** `readSession` already returned the settled OMP rows as reasoning then assistant, but `NativeChatMessageList` defensively re-sorted their equal timestamps by id. The decoder's ids (`${base}:reasoning` and `${base}`) therefore put the shorter assistant id first. `compareMessages` now recognizes that exact split-sibling shape before the generic id tie-break, preserving reasoning-before-reply without changing any other equal-timestamp ordering |

Note: commits are listed in dependency order, not `git log` order.

## Verified live facts (OMP 18.0.6, `/Users/rahul/.local/bin/omp`)

- `ready` frame advertises `protocolVersion: 1`, `supportedProtocolVersions: [1, 2]`,
  `maxFrameBytes: 1048576`, `maxReassembledFrameBytes: 67108864`. v2 negotiation succeeds.
  Those two byte counts are the SERVER's framing envelope, not constants of ours: the
  client validates only their shape (positive integers, reassembled ≥ frame) and sizes its
  chunk reassembler and stdout line cap from the advertised values, so an OMP release that
  ships a different budget is adopted rather than rejected as "not a ready frame".
- Command catalog returns 487–494 entries, including user-defined `/skill:*` commands.
- `prompt {message:"/usage"}` emits `command_output` frames, then a response carrying
  `data.agentInvoked: false`. Local commands must therefore **never** synthesize an
  assistant turn.
- v2 chunking is strictly in-order: one pending sequence, must start at index 0,
  `count >= 2`, per-chunk payload ≤256KiB, total `byteLength` ≥`maxFrameBytes` and
  ≤`maxReassembledFrameBytes` (the advertised envelope), exact byte-length match on
  completion. Deviations are protocol faults to surface, not tolerate — do not add an
  out-of-order/dedupe reassembler.
- Tool approval has **no dedicated frame**. It arrives as `extension_ui_request` with
  `method: "select"`, a free-text prompt, and Approve/Deny options.
- OMP has **no checkpoint verb**. Continuity is only `switch_session {sessionPath}` and
  `new_session {parentSession?}`, so checkpointing is a host-side convention.
- **`switch_session` requires the absolute session-file path, not the bare session id**
  (live-probed twice, omp 18.0.6, wave 3 / F12). Passing a bare id does **not** error — it
  silently fails to switch, and only a follow-up `get_state` reveals the session never
  changed (`sessionFile mismatch after switch`). This is the opposite of the CLI, whose
  `--resume` *does* accept a bare id; the two mechanisms are not interchangeable and
  conflating them was a real latent bug. Acquisition now resolves the real path via
  `resolveSessionFilePath('omp', …)` before switching, while the bare id remains the claim
  identity key. The env-gated probe that proves this lives in `omp-rpc-live.test.ts`.
- **Terminal-scoped breadcrumbs (`~/.omp/agent/terminal-sessions/<terminal-id>`) exist
  and are keyed by the plain basename of the pane's tty slave device path** — real files
  observed on this machine are named e.g. `ttys000`, matching `basename('/dev/ttys000')`,
  not any Orca-set env var (Orca sets `ORCA_PANE_KEY`/`ORCA_TAB_ID`, not one of OMP's
  recognized fallback identifiers `CMUX_SURFACE_ID`/`TMUX_PANE`/`TERM_SESSION_ID`/
  `WT_SESSION`, so OMP always falls through to the TTY path for an Orca-spawned pane).
  Content is `<cwd>\n<sessionFilePath>\n[fresh]` — a missing second line is only a
  legitimate non-stale state when the third line is `fresh` (a lazily-unmaterialized
  `/new` boundary), matching `continueRecent()`'s own documented validation rule
  (omp://session-switching-and-recent-listing.md).
- **No existing repo code computed OMP's session-directory cwd-encoding** before wave 4
  (`-<relative>` under home, `-tmp-<relative>` under the temp root, `--<encoded-absolute>--`
  otherwise) — `omp-terminal-session-identity.ts`'s `encodeOmpSessionCwdBucket` is a fresh
  implementation of the documented rule, verified against the real observed bucket name
  `-dev-projects-orca` for this repo's own checkout. The `--<encoded-absolute>--` case has
  no real-world example available to verify against; it is implemented per the literal
  spec and is only ever a fallback heuristic behind existence verification (see the trap
  below), so a wrong guess there degrades to "no candidate found," never a wrong write.
- **OMP does have a history-fetch verb — Orca's typed `OmpRpcCommand` union just doesn't
  include it yet.** `omp://rpc.md:188-193` documents `get_messages` and
  `get_messages_page` (cursor-paginated, returning `messages`/`totalMessages`/
  `nextCursor`, with machine-readable `session_busy` and `stale_cursor` error codes). A
  third-lab review (wave 6) asserted otherwise and concluded replace was therefore not a
  coherent alternative to overlay; that specific premise was wrong, but the overlay
  decision still stands, on better grounds: (a) D1 requires the transcript reader to stay
  alive regardless, so replace would *add* a history source rather than remove one; (b)
  `get_messages_page` explicitly refuses to page while the session is streaming or
  compacting, so it cannot serve live rendering precisely when the UI needs it most; (c)
  overlay bounds the id-less reconciliation (D4) to one in-flight turn instead of forever.
  `get_messages_page` is the likely mechanism for the deferred SSH/remote item (open item
  6) — a remote pane has no local transcript to overlay onto, which is exactly why the
  feature is local-only gated today. Not implemented this wave.
- **The recap never crosses the RPC wire (wave 7, live-probed).** A one-shot
  probe (`src/main/omp-rpc/omp-rpc-live-recap-probe.test.ts`,
  `ORCA_OMP_RPC_LIVE=1`) sent one trivial prompt over a session-owning client
  with the advisor active and dumped every frame, verbatim, from a complete
  real turn (18 frames total: `ready`, `commands` x3, `agent-start`,
  `turn-start`, `message-start`/`message-update` x3/`message-end` x2,
  `turn-end`, `agent-end`, two `extension_ui_request{method:'setWidget',
  widgetKey:'autoresearch'}` frames, and one `advisor_cost_changed` frame —
  the same event wave 1 observed live). Neither `recap` nor `※` appears
  anywhere in the dump outside one unrelated substring match inside the
  command catalog (a skill literally named
  `skill:aethos-staging-recapture-retrieval`). This settles UAT's bug 2b: the
  recap is TUI-rendered and never written to the transcript, the advisor
  file, or the RPC wire — see the Traps entry below for why a
  transcript-tailing (or RPC-tailing) chat can never show it.
- **Wave 9's live UAT reproduced the deadlock directly (OMP 18.0.9, dev build
  CDP 9432).** New tab → OMP → prompt "what is 7 times 6" confirmed on disk
  (session recorded the `42` reply) → toggle to Chat produced
  `ownership: {status:'idle', resolvedSessionId:null}`, `tabPtyId:null`,
  composer disabled ("No live terminal — toggle back to reconnect."), empty
  history — wave 8's `hasSendRoute` fix is inert because acquisition never
  runs. Direct IPC probes isolated why: `ompRpcChat.acquire(...)` returned
  `{ok:true}` (acquisition itself works) but
  `ompRpcChat.resolveSessionIdentity({ptyId:'x@@y', cwd:...})` while that
  session was claimed returned the pane's own OLDER, unrelated session
  (`mtime-fallback` source) even though the correct session's mtime was
  strictly newer — after `release()`, the same call returned the correct
  session. This is Defect 2 (`claimedSessionFilePaths` excluded the asking
  pane's own claim, not just other panes'). Defect 1 (the deadlock itself)
  traced to `ptyId` being both required by, and part of the cache key of,
  `use-omp-pane-session-identity.ts`'s `identityEligible`/`identityKey`,
  and duplicated in `use-omp-rpc-chat-pane-ownership.ts`'s own
  `identityEligible`/F9 latch key — acquire kills the pty → `ptyId` nulls
  → both hooks discard the resolved identity and flip ineligible →
  ownership resets to `idle` → composer disabled forever. Both fixed this
  wave; see the Shipped table and the standing-rule Trap entry below.
- **Wave 10's live UAT (dev build, CDP 9432) confirmed the first
  acquire/hand-back cycle now works end to end.** First Chat toggle
  acquires, composer enables ("Send a message…"), history renders, an RPC
  prompt streams and is written to the real session file, and hand-back
  respawns a PTY and resumes the correct session (verified via breadcrumb
  + on-disk JSONL) — wave 9's Defect 1/2 fixes hold. Toggling to Chat a
  SECOND time (a re-acquire after the successful hand-back) reproduced a
  new bug: `ownership: {status:'spawn-failed', resolvedSessionId:'01a047d1-…'}`
  (identity resolution correct — not at fault), `tab.ptyId` and
  `layout.ptyIdsByLeafId` both still pointing at the just-killed pty, and a
  process check finding **no** session-owning `omp --mode rpc` child and
  **no** omp TUI for that pane — `killPtyBeforeOmpRpcAcquire` killed the
  PTY, the RPC child failed to spawn (the machine had swap at ~95% during
  the run; the spawn failure itself is environmental and out of scope —
  see the Traps entry), and nothing restored the PTY: the exact "worst
  outcome" D1 exists to prevent. Root-caused and fixed this wave — see the
  Shipped table (`a9cca6315`).
- **Wave 11's live UAT (dev build, CDP) re-tested the same two-cycle path
  wave 10 fixed and found the PTY genuinely restored (`pty: 'live'` —
  `tab.ptyId`/`ptyIdsByLeafId[leafId]` both correctly rebound) but the
  composer still stuck on "No live terminal", disabled — a D1
  degrade-contract violation wave 10's own fix did not close. Traced to a
  fourth one-sided pty-binding site, this time not in the store at all:
  `TerminalPane.tsx`'s `chatPanePtyId`/`chatOwnerPtyId` — the sole source
  for the composer's `targetPtyId` and for `useOmpRpcChatPaneOwnership`'s
  own `ptyId` input — read exclusively from the pane's connected
  `PtyTransport` (`paneTransportsRef`), which `respawnPtyForOmpRpcChatHandback`
  never rebinds; the transport's own exit handling genuinely nulls itself
  when Decision 1's kill happens, and nothing ever tells it about the
  replacement PTY the RPC hand-back/restore spawns via IPC. Confirms cycle 1
  (acquire → stream → hand-back) is live-verified end to end (wave 10's own
  entry above); this wave's finding is specific to the acquire-failure
  restore path. Root-caused and fixed this wave — see the Shipped table
  (`969daa3d2`).
- **Wave 12's live UAT and re-test (CDP, real reasoning turns, Fable 5
  thinking high) found and closed two independent ordering defects.** First,
  the RPC reasoning overlay never retired because it was compared with the
  transcript's assistant prose; `nativeChatOverlayLeadsTranscriptReasoning`
  now retires it against the current turn's `role: 'reasoning'` row
  (`b63d72f5a`). The first re-test then exposed a second layer: `readSession`
  returned `[reasoning, assistant]` correctly, but the render list's
  equal-timestamp id tie-break reversed `${base}:reasoning` and `${base}`.
  The narrow split-sibling comparator fix (`0082f76fc`) preserves the decoder's
  semantic order. Final live proof: one "REASONING" row rendered before the
  answer, no duplicate overlay remained, the composer returned enabled at
  `idle`, and Chat → Terminal → Chat restored the same session and history.
- **The idle recap cannot be obtained over RPC — confirmed via a dedicated
  idle-window probe (wave 12).** A 200-second idle window held open on a
  session-owning RPC client, after a completed turn, produced **zero**
  frames of any kind — no `setStatus`, no `notify`, nothing. This is
  independent confirmation of, and consistent with, wave 7's
  complete-turn-dump finding above: OMP's recap is computed and rendered
  entirely client-side by the TUI (`recap.enabled`/`recap.idleSeconds`,
  driven by `ctx.showStatus` on terminal idleness) and never crosses the RPC
  wire under any condition tested, including sustained post-turn idleness,
  not just mid-turn activity. It cannot be obtained over RPC and MUST NOT be
  synthesized client-side — see the Traps entry above for why.
- **Advisor notes are durably persisted, and are definitively not the
  source of the recap (wave 12).** `__advisor.jsonl` records each finalized
  advisor turn as an `advise` toolCall with `arguments: { note, severity }`
  — live-confirmed example: `{ note: 'Stay silent — the answer already
  matches the ask.', severity: 'nit' }`. Severities are `nit`/`concern`/
  `blocker` only — there is no `recap` severity anywhere in the advisor
  record, ruling out the recap being a mis-surfaced advisor note. This
  remains the real path to surfacing advisor content later (open item 2c);
  reading `__advisor.jsonl` itself is still out of scope this wave.

## Design decisions

- **Ownership registry is the only safety mechanism.** OMP does not enforce single-writer,
  so `src/shared/claimed-agent-rpc-owner.ts` deliberately shares *one* registry with
  `claimed-agent-pty-owner.ts` rather than standing up a parallel one. An RPC child and a
  PTY child must never write the same OMP session concurrently.
- **Handoff ordering is the invariant:** dispose → prove exit → release → resume. An
  unprovable exit keeps the claim held and returns `unverifiable` (fail closed).
- **Never hardcode OMP surface.** Slash commands come from the catalog at runtime; the
  typed decoder is a floor, not a ceiling (`command_output` is untyped).
- **Raw frames:** opt-in, bounded diagnostic capture. Not a durable ledger.
- No dynamic third-party adapter loader and no arbitrary renderer code — built-in adapter
  only, against #10099's contract.
- **D5 — status derives from the RPC turn, not the hook, while RPC owns the
  pane.** `session.status` is overridden to `'working'` whenever
  `isOmpRpcTurnActive` is true, so Stop/isWorking/viewState react to the RPC
  stream instead of a hook that a PTY-exited pane will never emit again.
- **D2 (verified during wave 2, not just assumed).** Plain local "New tab ->
  OMP" never registers a claim in the runtime's shared
  `ClaimedAgentPtyOwnerRegistry` (`src/main/ipc/pty/pane/agent-session-owners.ts`)
  — that registry is populated only by the remote/paired-device resume path
  (`terminal.ensureAgentSession`/`createAgentSession`), never by a local
  `pty:spawn`. Real dual-writer safety for the RPC<->PTY handoff comes from
  `isLocalPtyAlive` (a genuine OS-level `provider.hasPty(ptyId)` check) plus
  `OmpRpcSessionOwner`'s fail-closed exit-proof gates, not from registry
  sharing with that global registry. This is why `OmpRpcChatSessionRegistry`
  is deliberately its own isolated `ClaimedAgentPtyOwnerRegistry` instance.
- **The pane's OMP identity is a session id; the RPC wire needs a path.** OMP's hook
  reports only a `session_id`, never a `session_file` (`agent-status-extension-source.ts`,
  #8962), unlike pi/prime-agent — so `transcriptPath` is always null for omp panes. The id
  is therefore the *claim identity*, and the session-file path used for `switch_session` is
  resolved from it at the IPC boundary. Do not pass the id to `switch_session`; see the
  live-probed fact above for why that fails silently.
- **Decision 1 (wave 4, amended wave 5, mount-anchor fixed wave 6) — kill-and-resume on first chat use.**
  Chat-view activation for an OMP pane acquires the session by killing the pane's
  PTY (`pty.kill(ptyId, {keepHistory:true})`, single-PTY granularity, best-effort
  — the registry's existing liveness/exit-proof gate is the real proof) and
  resuming that same session in the RPC child, holding RPC ownership for the
  pane's life. Killing suppresses the exit first (`suppressPtyExit`, left armed
  — wave 5, Critical A) and proactively clears the tab's pty binding to a
  well-defined "RPC-owned, no PTY" state, rather than leaving an unsuppressed
  exit to route through the same teardown a genuine crash would (it closed the
  whole tab for the common single-pane case).
  **Wave 5 replaced the wave-4 hand-back design.** The original design used a
  second, `isVisible`-gated effect deferring past a tick then polling
  `turnState` indefinitely for settlement, reconciled with F9 as a separate
  effect from acquire/release. A cross-lab review found this effect is
  *unreachable*: the real "leave Chat view" trigger (`TerminalPane.tsx`'s
  portal render gate returning null) unmounts the whole hook, which `isVisible`
  flipping while mounted does not model — `rerender()` in the wave-4 tests
  modeled the wrong transition and is why they passed against the broken
  trigger (see the Traps entry below). The actual trigger — the *first*
  effect's unconditional cleanup — released through `handoffToPty`'s then-
  unconditional abort, so a mere view toggle silently aborted a live turn, the
  exact outcome F9 forbids, and never respawned a PTY at all.
  **Hand-back ownership now lives in main, not the renderer hook.** The acquire
  effect's cleanup (and its cancelled-before-acquired race) express intent via
  `release({ paneKey, respawn: { replacedPtyId, cwd, sessionId } })` and return
  immediately — no polling, no settle-wait, in the renderer. Main's
  `handoffToPty` gates aborting behind an explicit, unused-by-default
  `allowAbort` opt-in (default: never abort; wait, bounded, for the turn to
  settle on its own; fail closed to `unverifiable` — keeping the claim — if it
  doesn't) and `performRelease` only tears down on the proven `'exited'`
  result. Only once release genuinely settles+exits does main push
  `ompRpcChat:handback` to the renderer; `use-omp-rpc-chat-handback-listener.ts`,
  subscribed once by `TerminalPane` (which stays mounted underneath
  `NativeChatView` through the very unmount that triggers hand-back), performs
  the actual `pty.spawn` + rebind via the unchanged
  `respawnPtyForOmpRpcChatHandback`. A respawned pty is still a fresh acquire
  identity (`ptyId` changed), so the F9 visibility latch still resets for it.
  **Known limitation, not fixed this wave:** if a turn never settles within
  `handoffToPty`'s bounded wait (`OMP_RPC_SETTLE_TIMEOUT_MS`, currently tuned
  for the settle-then-exit-proof sequence generally, not specifically for
  "user left Chat view mid-turn"), the release fails closed and nothing retries
  it — the pane is left with neither a live PTY nor a respawned one until the
  user returns to Chat view (which re-attaches to the still-running session,
  since `acquire()` finds and reuses it) or the process is otherwise handled.
  This trades a possibly-long "no terminal" window for never silently killing
  live work — deliberately, per the brief that drove this wave — but a
  durable retry-until-settled loop (mirroring the old effect's indefinite
  poll, just hosted where it can survive the unmount) is future work if that
  window proves too disruptive in UAT.
  **Wave 6 amendment — the "pane's life" claim above was aspirational, not
  actual, until this wave.** A third-lab architecture review found the
  acquire/hold hook (`use-omp-rpc-chat-session.ts`) was mounted inside
  `NativeChatView`, which mounts only while Chat view is showing — so every
  ordinary Terminal<->Chat toggle unmounted it, releasing (dispose, prove
  exit, respawn a PTY) and re-acquiring (kill, spawn) on the very next
  toggle back, up to ~15s of bounded waits plus omp cold-start for a toggle
  that is instant today. The hook (renamed
  `use-omp-rpc-chat-pane-ownership.ts`) now mounts once in `TerminalPane`
  instead — the surface wave 5's hand-back listener already lives on for
  exactly this reason — and publishes status/turnState into a
  paneKey-scoped store slice (`ompRpcChatOwnershipByPaneKey`) rather than
  returning React state, since the component that owns this lifecycle is no
  longer the component that renders it; `NativeChatView` is now a pure
  remountable subscriber (`use-native-chat-omp-rpc-integration.ts`). Every
  guard above (F9 latch, F5 generation/StrictMode, cancelled-before-acquired,
  bounded conflict retry, `suppressPtyExit`-before-kill left armed,
  `allowAbort` false, D1 fail-closed degrade) carries over unchanged onto the
  new lifecycle — only the mount point moved. Release fires only on a
  genuine identity rebind, pane/tab close, or app quit, never a bare view
  toggle. `use-omp-rpc-chat-handback-listener.ts` is unaffected: it was
  already anchored at `TerminalPane`, subscribed once regardless of which
  hook drives acquisition above it.
- **Decision 2 (wave 4, hardened wave 5) — bypass the broken hook, resolve from OMP's own on-disk
  state.** Rather than wait on open item 2's hook-delivery fix, the pane's OMP session
  identity is resolved directly from `~/.omp/agent/terminal-sessions/<terminal-id>`
  (preferred) or the newest-by-mtime file in the pane's encoded-cwd session bucket
  (fallback heuristic), then confirmed by the existing post-acquire `get_state()` check
  that was already in `OmpRpcSessionOwner.acquire()` from wave 3's F12 fix — that check
  already *is* Decision 2's "confirm via get_state," no new code was needed for it. Every
  resolved path is verified to exist on disk before being handed to `switch_session`
  (`omp-terminal-session-identity.ts`) — the single most dangerous failure mode this wave
  guards against is a wrong path silently minting an empty session (see the trap below).
  This closes open item 1's gate (b) without depending on item 2's fix; item 2 (hook
  delivery to the renderer) remains open and still blocks the *transcript-reading* path
  for a PTY-hosted (non-RPC-owned) OMP pane — a separate, still-broken concern this wave
  did not touch.
  **Wave 5 hardening (secondary review findings C/D/E, all Medium/Low, none exploitable):**
  the breadcrumb cwd comparison and cwd-bucket encoding now normalize both sides (realpath
  + trailing-slash strip) before comparing, so a symlinked worktree or a trailing slash no
  longer reads as stale-tty mismatch (finding D); the mtime fallback excludes session files
  another live pane already claimed via a new `claimedSessionFilePaths` option, so two panes
  sharing a cwd can no longer both resolve to the same session (finding C); and
  `resolveSessionIdentity`'s IPC handler now verifies pty locality itself via
  `localPtyProvider` before scanning local disk, rather than relying solely on the
  renderer's own `runtimeEnvironmentId === null` gate (finding E).

## Open work, in recommended order

1. ~~Streaming turns over RPC~~ — **built (waves 1-3), both handoff gates closed
   (wave 4), still not live-exercised against a real OMP pane.**
   `prompt`/`steer`/`follow_up`/`abort`, message/tool/turn frames, and
   `extension_ui_request` are wired end-to-end into `NativeChat`: acquire/subscribe/release
   lifecycle, overlay rendering, D5 status override, composer send routing, the Follow up
   affordance, and the extension-UI card. Two adversarial reviews then found 12 defects
   (2 critical, 6 high) — all fixed in `fcb5180aa` with a regression test each. **Every
   invariant D1-D7 has at least one test that fails if it regresses.**
   Wave 4 closed the two gates that previously blocked acquisition entirely:
   (a) *Handoff trigger* — **closed by Decision 1.** Acquisition now kills the pane's
   live PTY and resumes it in the RPC child, instead of only ever finding one already
   exited.
   (b) *No session id to acquire with* — **closed by Decision 2.** The pane's session
   identity is resolved from OMP's own on-disk state (breadcrumb, then mtime fallback),
   bypassing the broken hook chain entirely, rather than waiting on item 2's fix.
   Read this honestly: the feature is *tested*, still not *proven in a live app*.
   Wave 5 additionally repaired two Critical defects a cross-lab adversarial
   review found in wave 4's kill-and-resume/hand-back machinery — an
   unsuppressed kill that could close the whole tab (Critical A), and an
   unreachable hand-back effect whose real trigger silently aborted a live
   turn and never respawned a PTY (Critical B) — see Decision 1's amendment
   above. No end-to-end run against a real OMP pane has happened yet — that
   is explicitly the next wave's job, and it needs a human at the keyboard
   (New tab → OMP, open Chat, watch a real turn stream, switch to Terminal
   view mid-turn and back, confirm the interrupted-turn status row renders
   on a killed-mid-turn resume, confirm a mid-turn "leave Chat view" neither
   aborts the turn nor loses the PTY once it settles). The wave-1/2 and
   wave-4 experience is the argument for doing that UAT before trusting any
   of it: two waves in a row shipped a critical defect that only a live
   probe (wave 2) or a cross-lab adversarial review (wave 4) caught, never
   the wave's own test suite. Wave 4's own new mechanisms
   (terminal-id-from-tty-path, the cwd-bucket encoding's `--<encoded-absolute>--` branch)
   are similarly unverified against a real OMP process — see the "Verified live facts"
   caveats above.
   Wave 6 additionally fixed two real defects a third-lab architecture
   review found that five waves and two implementation reviews missed: the
   turn-completion flicker (overlay gated on the binary `working` flag
   instead of transcript content coverage) and RPC ownership actually being
   scoped to the Chat-view mount rather than the pane's life as Decision 1
   always intended. Wave 13 completed the missing live UAT: cold acquisition,
   transcript hydration, Terminal↔Chat toggles, and an active turn all retained
   one pane-scoped RPC owner. It also fixed the shortcut mount and leaf-route bug.
2. **Hook delivery to the renderer for OMP panes** — still broken end to end. No longer
   blocks item 1's acquisition path (Decision 2 bypassed it), but still blocks the
   *transcript-reading* path for a PTY-hosted (non-RPC-owned) OMP pane: `sessionFile`/
   `sessionId` for that path still comes from this broken hook chain. Four code gates
   were fixed in `763add4d4` and unit-proven, but a live pane still records nothing after
   a *complete* turn. Proven chain: no hook event → `recordAgentProviderSession`
   never fires → no provider session id → `nativeChat.readSession` returns
   `{error:"Transcript unavailable", notFound:true}` → the chat view renders the user
   message but never the assistant reply, and `agentStatusByPaneKey` stays empty. `/usage`
   is unaffected only because it bypasses the transcript entirely.
   **Wave 7 amendment — closed for the RPC-owned chat view specifically, still open for
   the underlying hook.** Live UAT hit exactly this: an RPC-owned pane's Chat view still
   fed the transcript read from this same broken `resolution.sessionId`, so the pane
   rendered the empty state ("Start a chat with OMP") even after a completed turn, with
   the composer correctly reporting no live terminal (RPC ownership had already killed
   the PTY) — a D1 violation in practice: neither history nor terminal. Wave 4 built the
   hook bypass (`use-omp-pane-session-identity.ts`, Decision 2) but wired it only to
   acquisition, not the transcript read. `NativeChatView.tsx`/`native-chat-pane-resolution.ts`
   now prefer a *sticky, store-published* copy of that resolved identity
   (`ompRpcChatOwnershipByPaneKey[paneKey].resolvedSessionId`, written by the ownership
   hook once known and never cleared by the pane's own later ptyId churn) over the hook
   value — `resolveEffectiveNativeChatSessionId`. This closes the gap for the chat view
   without fixing the hook itself; item 2's hook-delivery fix (below) is still what a
   PTY-hosted (non-RPC-owned) OMP pane needs.
   Prime suspect: prod and dev builds write the same
   `~/.omp/agent/extensions/orca-agent-status.ts`, so hook endpoint routing can cross apps.
   Check whether the extension embeds an endpoint at write time or reads it from env at
   runtime (`src/main/pi/agent-status-extension-source.ts`,
   `src/main/ipc/pty/host-env/pi-agent.ts`, `src/shared/agent-hook-endpoint-file.ts`).
2c. **Advisor transcript rendering (Bug 2c) — deferred, not implemented this wave.**
   `omp://advisor-watchdog.md` documents that every finalized advisor turn is appended to
   `__advisor*.jsonl` inside the owning session's artifacts directory (reserved
   `__advisor` stem, append-only, follows session switches) — confirmed present and
   correctly shaped for `decodeOmpTranscriptLine` (`type:'message'` rows carrying
   `thinking`/`text` content, so Bug 2a's reasoning split already applies to it verbatim
   if it were ever read). The doc also states accepted advisor notes land in the primary
   transcript too, as XML-escaped `<advisory>` elements — Orca's decoder does not
   currently decode that element at all, so double-rendering is not yet a risk, but any
   future advisor read must check this before rendering both sources. Deferred rather
   than implemented because: (a) it needs a new read source stitched into the message
   list as a distinct, clearly-attributed, read-only "advisor" row — not a small addition
   alongside Bug 1/2a/2b's scope, and this wave's working rules cap live-UAT-driven fixes
   to what the UAT actually surfaced (the advisor's *absence* from chat was not itself a
   reported UAT symptom, only inferred while investigating the recap); (b) the artifacts
   directory's path-derivation-from-session-file rule is not yet implemented anywhere in
   this codebase and needs its own existence-verification discipline (the same
   never-hand-an-unverified-path lesson `omp-terminal-session-identity.ts` already
   learned), which is real, unrehearsed work; (c) the dedup story against the `<advisory>`
   primary-transcript duplicate needs a decoder change, not just a new read call. Next
   wave's job if wanted: read `__advisor*.jsonl` alongside the primary transcript,
   render its turns as a distinct advisor-kind row, and decode/suppress `<advisory>`
   elements in the primary transcript so the same note is never shown twice.
3. Subagent frames; unknown-frame diagnostic rendering; opt-in raw capture.
4. **Complete session-scoped command routing.** `/usage` now runs over RPC and renders
   its captured output plus the explicit local-command completion marker. Every other
   catalog command still falls back to the PTY path, which is unavailable while RPC owns
   the pane. Route those commands through the owning session, then consume the
   `session_info_update` and `config_update` side channels that current `rpc.md` documents.
   The current OMP RPC source does not publish a `session_switch` wire frame; the older
   instruction to subscribe to one was stale.
6. SSH/remote runtime locality; mobile read parity (`nativeChatRequiresLocalTranscript`
   semantics change once RPC bypasses disk) — the RPC session hook is already
   local-only-gated (`runtimeEnvironmentId === null`), so this item is scoping
   the *removal* of that gate, not adding one. Wave 4's new mechanisms (`getSlavePath`,
   the terminal-id/breadcrumb resolver) are also local-provider-only today — a daemon or
   SSH pane's `getSlavePath` is absent, so those panes fall straight to the mtime-fallback
   heuristic; extending real breadcrumb resolution to them is part of this item, not done.
7. Upstream PR against #10099 after the remaining parity tracks below. Core live UAT is
   complete; the blocker is now missing protocol/host coverage, not an unexercised owner.
8. **`spawn-failed` on a re-acquire is undetermined, not root-caused — needs a
   clean-machine retest (wave 11).** Both wave 10's and wave 11's live UAT
   reproduced the RPC child failing to spawn on a second acquire, but both
   runs had the test machine under heavy memory pressure (wave 10: ~95%
   swap; wave 11: ~93% swap) with no spawn error surfaced in the main-process
   logs either time. Explicitly not chased this wave (see the working rules
   above) — do not add retries or weaken the exit-proof/single-writer gates
   to paper over it. This wave's fix (`resolveEffectiveChatPanePtyId`) makes
   the *outcome* of a `spawn-failed` status safe (a restored pty still gets
   a working composer), which is orthogonal to *why* the spawn itself fails.
   Next step: re-run the same two-cycle UAT on an otherwise-idle machine; if
   `spawn-failed` still reproduces there, it is a genuine product defect
   worth its own investigation, not an artifact of memory pressure.

## Traps that cost real time

- **Recap transport is now available, but requires the matching OMP change.** The old
  ceiling was real for OMP 18.0.6: recap existed only in TUI memory. OMP branch
  `feat/rpc-idle-recap` (`460ff2f753`) adds typed `recap_update` frames and
  `get_state.latestRecap`; Orca now validates, reduces, invalidates, and renders those
  frames as the same `※ recap:` aside. Until that OMP change lands in the runtime Orca
  launches, no client can receive the frame. Reconnect hydration from
  `get_state.latestRecap` remains part of the history/reconnect track.
- `hydrateShellPath` (`src/main/startup/hydrate-shell-path.ts`) caches its result promise
  process-wide **including a cold-start timeout failure**, which made `omp` permanently
  unresolvable (`executable-not-found` forever). `src/main/ipc/omp-rpc-executable-resolver.ts`
  works around it: bare PATH → hydration → *forced* re-hydration → well-known posix
  installer paths. Do not "simplify" this back into a single hydration call.
- An empty `agentStatusByPaneKey` on a booted-but-unprompted pane is **designed** —
  identity routes to the cold-restore map (`sleepingAgentSessionsByPaneKey`). Do not treat
  it as the bug; the real gap only appears after a full turn.
- Reaching the Chat UI requires a tab with `launchAgent: "omp"` (New tab → OMP). Typing
  `omp` into a plain shell leaves `launchAgent: null` and the chat toggle stays gated.
- Use `npx -y pnpm@10.24.0`; the repo pins 10.24.0. Dev builds get a separate userData
  namespace and a deterministic CDP port of 9432.
- Repo gates that bite: oxlint forbids `Array<T>`; child processes only via
  `src/shared/child-process/`; `.ts` not `.d.ts` for owned types in `src/preload`/`src/shared`;
  never add a `max-lines` disable — split the file.
- **A wrong session path silently creates an empty session, not an error** —
  `setSessionFile` treats ENOENT and a malformed header as "empty" and initializes a
  brand-new session at that exact path. This is why `omp-terminal-session-identity.ts`
  verifies existence twice (once when accepting a breadcrumb/mtime candidate, once
  immediately before returning it) and why a stale breadcrumb (recorded cwd disagrees
  with the pane's actual cwd — tty device paths are reused across processes) is discarded
  rather than trusted. Any future caller of the resolved path must keep this discipline —
  never hand an unverified path to `switch_session`.
- **A `rerender()` in a hook test can silently model the wrong transition.**
  Wave 4's hand-back tests used `rerender({...BASE_ARGS, isVisible: false})`
  to simulate "leaving Chat view," but the real trigger unmounts the
  component (`TerminalPane.tsx`'s portal render gate returning null, not a
  prop change on a persistently-mounted instance) — `rerender()` re-renders
  the *same* mounted instance and cannot model an unmount. The suite was
  internally consistent with the resulting bug (Critical B) and gave false
  confidence; four tests had this mistake, all in the same describe block.
  **Any test asserting lifecycle behavior for a transition that unmounts a
  component in production must use `unmount()` (and remount where relevant),
  never `rerender()` with changed props** — a passing test that models the
  wrong transition is worse than no test. `rerender()` remains correct for
  transitions that genuinely happen on a persistently-mounted instance (e.g.
  F9's visibility toggle, or an identity rebind while still eligible).
- **The happy path was the broken path, and it survived seven waves because
  every test supplied a PTY (wave 8).** Decision 1 acquisition kills the
  pane's live PTY on a *successful* acquire — that is the whole point of
  the kill-and-resume design. But `NativeChatComposer.tsx`'s send-capability
  flag was computed from `targetPtyId !== null`, so the composer disabled
  itself (textarea, send button, and the "No live terminal — toggle back to
  reconnect." placeholder) at exactly the moment acquisition succeeded — the
  RPC send route wave 2 built was live code that could never run in the
  running app. Wave 7's own live UAT hit the empty-transcript symptom one
  layer up (Bug 1) and never reached the composer, because typing was
  already blocked before a prompt could be sent. `useNativeChatComposerSend`
  and `useNativeChatPickerCommandDispatch` had an independent instance of
  the identical mistake one layer down — both resolved a PTY target and
  bailed before ever trying the RPC send/local-command routes, so fixing
  only the composer's `disabled` flag would have left every send silently
  no-op'ing under a now-enabled-looking textarea. Every prior wave's tests
  passed because every one of them constructed the composer/hooks with a
  non-null `targetPtyId` — there was no fixture for "RPC owns this pane and
  the PTY is gone," so nothing ever exercised the state Decision 1's own
  design puts a pane into on success. **Lesson: when a feature's own design
  document says a precondition (here, a live PTY) is deliberately removed on
  the success path, every consumer of that precondition needs a test with it
  removed — a green suite built entirely on the failure/fallback shape of a
  flag proves nothing about its removal.**
- **Standing rule (wave 9, third occurrence of the same mistake class):
  nothing on the chat path may depend on a live `ptyId` — including cache
  keys and eligibility gates, not just UI-disabled flags.** Wave 8 found
  `ptyId !== null` baked into the composer's send-capability flag (a
  *display/action* gate). Wave 9 found the identical assumption baked into
  *identity resolution's cache key* (`use-omp-pane-session-identity.ts`)
  and into *ownership's own eligibility gate*
  (`use-omp-rpc-chat-pane-ownership.ts`) — both upstream of the composer,
  both invisible to wave 8's fix. Decision 1's acquisition kills the pane's
  PTY on every successful acquire; that is not an edge case, it is the
  *normal* post-acquisition state for the rest of a pane's owned life. Any
  future code on this path that reads `ptyId`, `targetPtyId`, or any prop
  derived from a pane's live terminal must ask "does this still need to be
  true after Decision 1's own kill?" before using it as a precondition —
  if the answer is no, gate on the pane's *identity* (`paneKey`/`cwd`/
  `sessionFile`) instead, and treat `ptyId` as an optional accuracy input,
  never a requirement. Grepped and dispositioned every live-PTY dependency
  in `src/renderer/src/components/native-chat/` as of this wave: the
  remaining ones (`use-native-chat-interactive-send.ts`,
  `use-native-chat-send-lifecycle.ts`,
  `use-native-chat-session-options.ts`'s screen-snapshot/model-picker
  scoping, `NativeChatComposer.tsx`'s `attachDisabled`,
  `native-chat-composer-target.ts`'s remote-runtime check) are all
  genuinely PTY-scoped operations — writing into a live terminal, snapshotting
  its buffer, or gating a PTY-only affordance — not identity/ownership
  gates, and correctly still require a live `ptyId`.
- **A "superseded generation, don't touch shared state" guard can silently
  swallow an obligation that isn't shared state (wave 10).** Wave 7's
  restore-on-acquire-failure call in `use-omp-rpc-chat-pane-ownership.ts`
  sat after the `generation !== generationRef.current` check that exists
  to stop a stale effect run from publishing *status* over a newer run's —
  correct for status, wrong for the restore call, which does not touch
  anything the newer run owns. Giving back the *specific* PTY this run
  itself killed (closed over in its own `respawnContext`) can never race a
  different generation's kill/restore of a *different* ptyId, so gating it
  behind the same check as status-publishing let a real re-acquire race
  (a later run starting for the same identity before this run's
  `acquireOnce()` had settled) skip restoration entirely — the pane ended
  up with neither a live PTY nor RPC ownership, live-UAT-proven. **Lesson:
  before reusing a "some other run now owns this" guard for a second
  purpose, check whether that purpose is actually about ownership of
  shared state, or a private obligation (something only this run did) that
  must discharge regardless of who owns what afterward.**
- **Standing rule (wave 11, fourth occurrence of the one-sided
  pty-binding mistake class — wave 8 composer, wave 9 identity, wave 10
  layout-leaf clear, this wave the transport): a pty binding has THREE
  independent representations in this codebase, not two.** Prior waves
  treated `tab.ptyId` and `terminalLayoutsByTabId[tab].ptyIdsByLeafId`
  as the whole story and kept them symmetric. There is a third: the
  pane's connected `PtyTransport` (`paneTransportsRef`), whose own
  `getPtyId()` only ever changes through *its own* `connect()`/reattach
  machinery (SSH reattach, daemon cold-restore, `connectPanePty`'s
  initial bind, `handleRestartCodexPane`'s explicit destroy+reconnect) —
  every one of those paths calls back into the transport itself when it
  rebinds. `respawnPtyForOmpRpcChatHandback` (Decision 1's kill-and-resume
  hand-back, and the D1 fail-closed restore on acquire failure) rebinds
  the store pair correctly but never touches the transport, so
  `TerminalPane.tsx`'s `chatPanePtyId`/`chatOwnerPtyId` — computed
  *exclusively* from the transport, no store fallback — stayed null
  forever after Decision 1's own kill even once the store showed a live
  replacement pty. **Lesson: "the store is symmetric" is not the same
  claim as "every consumer reads the store" — grep for `paneTransportsRef`
  reads, not just store writes, before declaring a pty-binding fix
  complete.** `resolveEffectiveChatPanePtyId` is now the one place that
  reconciles transport vs. layout for chat purposes; any future Chat
  surface that needs "is there a live pty for this pane" must call it,
  not read `paneTransportsRef` or the store directly.

## Verification baseline

Full sweep after wave 6 (`a14b816f8`): `npx -y pnpm@10.24.0 tc` — exactly 9
`tc:web` errors, all in `src/renderer/src/components/automations/**` at
identical file:line to wave 5's baseline (upstream `cda2280d6`), zero new;
`tc:node`/`tc:cli` clean. `check:code-quality:changed` — 0 findings across
102 changed files (code quality, type-aware code quality, React Doctor all
clean). `electron-vite build` clean (main + preload + renderer, exit 0).

Full `npx -y pnpm@10.24.0 test` (62,579 tests): 12 failures observed —
exactly wave 5's documented baseline, all pre-existing and unrelated (none
touch a file this wave changed):
- 10 in `src/renderer/src/components/automations/**` (incl.
  `automation-scoped-list-client.test.ts`), the same `hasCustomSchedule`/
  `getAutomationOwnerTarget`/`AutomationsApi.create` `ReferenceError`s from
  upstream `cda2280d6` — same root cause as the 9 `tc:web` errors.
- 2 in `repro-13767-shell-ready-marker-lost-to-exec.test.ts` (real-subprocess
  PTY timing; imports nothing this branch touches).

Zero failures in any `native-chat`/`store`/`terminal-pane`/`pty` file — a
combined targeted sweep of `src/renderer/src/components/native-chat`,
`src/renderer/src/store`, and `src/main/ipc/omp-rpc-chat.test.ts` (386
files, 3858 tests) passed clean, and a second sweep of
`src/renderer/src/components/terminal-pane` plus `src/main/ipc/pty` (455
files, 4403 tests + 7 pre-existing skips) passed clean.

W6-1: `omp-rpc-turn-reducer.test.ts` rewrites the flicker-locking assertion
into two tests (keeps rendering past a terminal `agent_end` until the
transcript catches up; drops once it does) plus a reasoning-path
equivalent — 3 net new tests.

W6-2: `use-omp-rpc-chat-session.ts`/`.test.ts` become
`use-omp-rpc-chat-pane-ownership.ts`/`.test.ts` (30 tests — every guard
from wave 5 re-verified on the new lifecycle, plus a `paneKey: null`
eligibility case; `unmount()` now models real pane/tab close, `rerender()`
models the ordinary visibility toggle that no longer unmounts anything).
New `src/renderer/src/store/slices/omp-rpc-chat-pane-ownership.ts` (the
paneKey-scoped publication slice, registered in `store/index.ts`,
`store/types.ts`, `store/slices/store-test-helpers.ts`).
`use-native-chat-omp-rpc-integration.ts`/`.test.ts` rewritten as a pure
store subscriber, with a new regression test asserting mount/rerender/
unmount perform zero RPC IPC. `NativeChatView.tsx` and `TerminalPane.tsx`
updated for the new call sites — `use-omp-rpc-chat-handback-listener.ts`
is unchanged (already anchored at `TerminalPane`).

Live evidence so far: unchanged from wave 5 — the 494-command catalog and
`/usage` render correctly in the dev app (wave 1); wave 3's F12 probe
live-verified `switch_session` path-vs-id semantics. Everything wave 4-6
added, including every fix in this wave, rests on unit tests against real
temp-fs fixtures and a real (non-mocked) Zustand store — never a real OMP
process. **The streaming-turn path, the kill-and-resume acquire trigger, and
the hand-back respawn have still never run against a real OMP pane** — that
is explicitly the next wave's job (open item 1), and per the working rules
for this wave it was not attempted here.

## Wave 9 verification

`npx -y pnpm@10.24.0 tc` — **0 errors, all three projects clean** (the
branch merged with upstream `8fa1b3c16` before this wave, which fixed the
`automations/**` breakage prior waves' baseline carried).
`check:code-quality:changed` — 0 findings (code quality, type-aware code
quality, React Doctor all clean, 120 changed files) after adding one
`oxlint-disable-next-line react-hooks/exhaustive-deps` (with a `Why:`
reason comment, matching the repo's existing convention) for the acquire
effect's deliberate exclusion of `ptyId`/`identityKey` from its dependency
array — the entire point of the fix.

Targeted suites for every touched file (5 files, 100 tests) pass clean:
`use-omp-pane-session-identity.test.ts`,
`use-omp-rpc-chat-pane-ownership.test.ts`, `omp-rpc-chat.test.ts`,
`omp-terminal-session-identity.test.ts`, `omp-rpc-chat-session-registry.test.ts`
— including the 6 acceptance tests from the brief (identity/ownership
survive `ptyId` going null; identity resolves with no `ptyId` via the
mtime fallback; a pane re-resolving its own claim gets its own session
back; two panes sharing a cwd bucket never collide; D1's PTY-present path
is unchanged).

`npx -y pnpm@10.24.0 test` (64,696 tests): 5 failures observed on the full
parallel run, none in a file this wave touched. Isolation re-run
attributes each:
- 2 in `repro-13767-shell-ready-marker-lost-to-exec.test.ts` — still fail
  in isolation (real-subprocess PTY timing), matching the documented
  baseline exactly.
- 2 in `browser-route-h3-egress.electron.test.ts` /
  `browser-route-persisted-worker-egress.electron.test.ts` — pass clean in
  isolation; part of the documented "6 `browser-*.electron.test.ts`,
  load-sensitive" baseline bucket, only 2 of the 6 manifested under this
  run's load.
- 1 in `palette-match-performance.test.ts` (a 95th-percentile timing
  budget, 222ms vs a 220ms budget) — passes clean in isolation; a load
  flake, not in the documented baseline bucket but the same class (timing
  assertion under parallel-suite load) and in a file this wave never
  touched.

`npx -y pnpm@10.24.0 exec electron-vite build` — clean, exit 0.

Live evidence: this wave's own UAT (see "Verified live facts" above) is
the first time the streaming-turn path, the kill-and-resume acquire
trigger, and the identity/ownership lifecycle ran against a real OMP pane
and produced live IPC evidence for both defects. The fix itself is
unit-verified only — re-running the same live UAT against this fix is
explicitly the next step, per the working rules for this wave (do not
attempt live UAT; re-run by the human).

## Wave 10 verification

`npx -y pnpm@10.24.0 tc` — **0 errors, all three projects clean**.
`check:code-quality:changed` — 0 findings (code quality, type-aware code
quality, React Doctor all clean, 123 changed files).

Targeted suites for every touched file pass clean:
`use-omp-rpc-chat-pane-ownership.test.ts` (42 tests, 4 new — a race
reproduction that reverting the fix demonstrably fails, a
retry-on-respawn-failure test, a full acquire→hand-back→acquire cycle
test, and layout-leaf-clear coverage), `terminal-layout-pty-clear.test.ts`
(new, 4 tests for `clearTerminalLayoutPanePtyId`), plus regression sweeps
of `omp-rpc-chat-handback.test.ts` and
`terminal-pty-identity-replacement.test.ts` (53 tests total across the 4
files).

`npx -y pnpm@10.24.0 test` (64,704 tests): 3 failures on the full parallel
run, none in a file this wave touched. Isolation re-run attributes each:
- 2 in `repro-13767-shell-ready-marker-lost-to-exec.test.ts` — still fail
  in isolation (real-subprocess PTY timing), matching the documented
  baseline exactly.
- 1 in `managed-hook-script-refresh.test.ts` (`ENOTEMPTY` removing an
  isolated tmp userData dir) — passes clean in isolation; a tmpdir-cleanup
  race under full-suite parallel load, unrelated to this wave (the file
  has no relationship to native-chat/terminal/pty code).

The previously-documented "6 `browser-*.electron.test.ts`, load-sensitive"
bucket did not manifest any failures on this run.

`npx -y pnpm@10.24.0 exec electron-vite build` — clean, exit 0.

Live evidence: this wave's fix is unit-verified only, per the same
working-rule constraint as wave 9 (re-running the live UAT is the human's
next step). The race the new test reproduces was confirmed against the
pre-fix code (reverting just the source change makes it fail with the
exact "restore never called" symptom the live UAT observed), then
confirmed passing again with the fix restored — the closest available
substitute for a second live CDP run this wave.

## Wave 11 verification

`npx -y pnpm@10.24.0 tc` — **0 errors, all three projects clean**.
`check:code-quality:changed` — 0 findings (code quality, type-aware code
quality, React Doctor all clean, 125 changed files).

Targeted suite for the new file: `native-chat-effective-pty-id.test.ts` (5
tests, new — transport-wins, layout-fallback, both-null, undefined-layout,
and the full acquire→hand-back→acquire-fails→restored cycle modeled purely
through the resolver). Combined regression sweep of every touched/adjacent
surface — `native-chat` (all files), `store`, `src/main/ipc/omp-rpc-chat.test.ts`,
and `terminal-pane/pty-connection` — 460 files, 4614 tests, passed clean.

`npx -y pnpm@10.24.0 test` (64,709 tests): 3 failures on the full parallel
run, none in a file this wave touched. Isolation re-run attributes each:
- 2 in `repro-13767-shell-ready-marker-lost-to-exec.test.ts` — still fail
  in isolation (real-subprocess PTY timing), matching the documented
  baseline exactly.
- 1 in `managed-hook-script-refresh.test.ts` (`ENOTEMPTY` removing an
  isolated tmp userData dir) — passes clean in isolation; the same
  tmpdir-cleanup race under full-suite parallel load wave 10 already
  documented, unrelated to this wave (the file has no relationship to
  native-chat/terminal/pty code).

The previously-documented "6 `browser-*.electron.test.ts`, load-sensitive"
bucket did not manifest any failures on this run.

`npx -y pnpm@10.24.0 exec electron-vite build` — clean, exit 0.

Live evidence: this wave's own live UAT (see "Verified live facts" above)
is what found the defect — a real dev-build CDP session, not a synthetic
repro. The fix itself (a pure resolver function with no React/IPC
surface) is unit-verified only; re-running the same two-cycle live UAT
against this fix is the human's next step, per the working rules for this
wave (do not attempt live UAT beyond what the brief already supplied).

**Deviation from the brief's prescribed fix, flagged per the working
rules.** The brief's root-cause hypothesis — that `killPtyBeforeOmpRpcAcquire`'s
`clearTerminalLayoutPanePtyId` call left `ptyIdsByLeafId` empty because the
restore path rebinds only `tab.ptyId` — does not hold against the code:
`respawnPtyForOmpRpcChatHandback` already calls both `updateTabPtyId` *and*
`rebindPaneLayoutLeaf` (→ `replaceTerminalLayoutPanePtyId`), and both are
unconditional writes (no stale-match guard blocks them), verified by
dedicated store-slice tests (`terminal-layout-pty-clear.test.ts`,
`codex-restart-notice-lifecycle.test.ts`'s `replaceTerminalLayoutPanePtyId`
suite) and by grepping every `updateTabPtyId` call site in the renderer for
a paired layout rebind — none are missing one. The store's tab-record/
layout-leaf pair is already symmetric; wave 10's fix holds exactly as
documented. The real gap is one layer up: `TerminalPane.tsx` never reads
that store pair for chat purposes at all — `chatPanePtyId`/`chatOwnerPtyId`
read only the pane's connected `PtyTransport`, a third, independent
pty-binding representation the RPC hand-back/restore path had never been
taught to update. Implemented the closest fail-closed alternative: prefer
the transport (the ordinary, most-authoritative source for every other pty
lifecycle) and fall back to the store's layout binding only when the
transport has none — see `resolveEffectiveChatPanePtyId`'s doc comment for
the full reasoning, including why reconnecting the transport itself
(real xterm byte-streaming) is a materially larger, separately-scoped
change this wave's contract does not require.

Two of the brief's four fix requirements do not carry over as written,
for the same reason: "guard the rebind the same way wave 10 guarded the
clear" assumed a new store-side write primitive; the actual fix is a pure
read-side preference (transport-if-present, else layout), which cannot
clobber a concurrent write — the transport, once it reconnects on its own,
always wins again. The brief's two required regression-test shapes
("`tab.ptyId`/`ptyIdsByLeafId[leafId]` both reference the restored pty" and
"a full acquire→hand-back→acquire-fails→restored cycle via `unmount()`/
remount") targeted hook/store-level tests under the original hypothesis;
since the real fix is a pure function with no React lifecycle or store
mutation at all, the equivalent coverage is the resolver's own full-cycle
test above (transport stays null throughout, exactly as it does live; the
store's layout binding is what advances at each step, matching the
already-verified wave 10 mechanics) plus the existing, unchanged composer
tests that already prove a non-null `targetPtyId` alone enables
`hasSendRoute` regardless of RPC ownership status.

## Wave 12 verification

`npx -y pnpm@10.24.0 run tc` — **0 errors, all three projects clean**.
`npx -y pnpm@10.24.0 run check:code-quality:changed` — 0 findings (code
quality, type-aware code quality, React Doctor all clean, 129 changed files).

The final targeted regression set passed **66/66** across:
`native-chat-message-grouping.test.ts`,
`native-chat-session-assembler.test.ts`,
`native-chat-incremental-assembler.test.ts`,
`native-chat-streaming.test.ts`, and
`omp-rpc-turn-reducer.test.ts`. It covers overlay retirement and anti-flicker,
reasoning-before-reply for both input orders, existing deterministic ties,
streaming-preview placement, and optimistic echoes.

`npx -y pnpm@10.24.0 test` (64,717 tests): 2 failures, both in
`repro-13767-shell-ready-marker-lost-to-exec.test.ts` — the documented
baseline's `repro-13767` bucket exactly (real-subprocess PTY timing,
unrelated to this wave; passes clean in isolation). The previously documented
6 `browser-*.electron.test.ts` failures did not manifest on this run.

`npx -y pnpm@10.24.0 exec electron-vite build` — clean, exit 0.

Final live UAT after both fixes: a new session-owning RPC turn streamed
reasoning (161 chars) and answer (185 chars), settled to `idle`, and rendered
exactly one labeled reasoning row before its assistant answer. The composer
was enabled afterward. Chat → Terminal respawned a PTY; Terminal → Chat
re-acquired the same session id with the same history and ordering.

The prescribed overlay fix matched its root cause, including the current-turn
boundary that prevents stale reasoning from suppressing a new turn. The live
re-test then found the independent equal-timestamp comparator defect; that
second fix is intentionally narrow to OMP's `${base}:reasoning` sibling id
contract (`0082f76fc`).
