# Agent status store

## Status

Proposed on 2026-09-09 as the follow-up to #19217. It lands in four steps, in
this order, each independently shippable:

1. main-only: every producer writes into one store and `worktree ps` reads it,
   split into 1a (structured sessions join the store) and 1b (the runtime's
   duplicate retained store is deleted);
2. renderer: the sidebar becomes a subscriber and stops re-deriving rows;
3. shared: one worktree-status rollup and one freshness rule for every reader.

The PR that carries this document is PR 1a. Sections below are grouped under
the step that delivers them; PR 1a and PR 1b have landed.

## The problem this solves

Orca shows "what is this agent doing" in four places: the desktop sidebar, the
`orca worktree ps` command, the mobile app, and the agent dashboard. Before
#19217 those readers did not even share their inputs. After #19217 they share
the structured-session mapping and nothing else.

An audit on 2026-09-09 found six producers and three consumers, and three
separate copies of the same row inside the main process alone:

| Main-process copy                 | Keyed by  | Owned by                                                                          | Persisted          | Evicted                      |
| --------------------------------- | --------- | --------------------------------------------------------------------------------- | ------------------ | ---------------------------- |
| hook server `lastStatusByPaneKey` | paneKey   | `src/main/agent-hooks/server.ts`                                                  | `last-status.json` | tab close, pty exit, hydrate |
| runtime `RuntimeAgentRowStore`    | paneKey   | `runtime-agent-row-store.ts` (deleted in PR 1b)                                   | no                 | pty exit only                |
| structured feed `published`       | sessionId | `src/main/native-chat/agent-session-wire/structured-agent-session-status-feed.ts` | no                 | never (a broadcast cache)    |

The second copy is a duplicate write: the OSC status parsed in main is
forwarded to the hook server _and_ retained in the runtime store from the same
call (`orca-runtime-create-terminal-side-effect-command-code-detector.ts`).
The third copy is keyed differently and never reaches the hook server at all,
which is why `worktree ps` grew its own adapter for it in #19217.

Each reader then applies its own precedence and freshness rules, so the same
pane can legitimately read differently on the desktop, on the phone, and in
the CLI.

## The rule

**The execution host owns agent status, in one store, and every reader
subscribes to it.** This follows the boundary in
[`ssh-execution-boundary.md`](./ssh-execution-boundary.md): the host that runs
the process is the only party that can observe it, and the client is never
authoritative for execution state.

Three consequences:

- One store per execution host. A remote host keeps its own store and the
  client mirrors it down, as the web-session mirror already does. Mirroring is
  not merging: a client never writes its observations back to a host.
- Precedence is decided once, at write time, with provenance recorded on the
  row. Readers never re-adjudicate hook versus terminal versus structured.
- Readers keep only presentation policy and user facts: the 30-minute display
  decay, acknowledgements, dismissals, unread. Those stay reader-side but
  become one shared implementation (PR 3).

## The store already exists

The hook server's state is that store today for every PTY-based agent. The
audit established:

- hook HTTP posts, the WSL and SSH relay receivers, and main's own OSC parse
  all converge on the same `applyNormalizedStatus` path, stamped with the
  authority id `main-agent-hooks`;
- it alone holds pane authority: launch tokens and their hashed commitments,
  retired-pane fences, pane-key aliases, per-connection ordering watermarks,
  and the evidence-age map that must outlive a transport clear;
- it alone persists, with a seven-day hydrate window and the
  `restoredUnconfirmed` stamp that keeps a hydrated row from ever reading as
  live truth;
- it already fans out to both renderer windows over `agentStatus:set` and
  `agentStatus:clear`, and serves `agentStatus:getSnapshot`.

Nothing else in main carries those guarantees, and building a second store
with them would be the wrong direction. So the design is not "add a store". It
is: **route the two producers that bypass the hook server through it, then
delete the copies.**

## PR 1a: structured sessions publish into the store

No renderer behavior changes. The sidebar keeps receiving the same IPC events
it receives today, plus structured-session rows it currently derives itself.

### Structured sessions publish into the hook server

The structured feed keeps its job of projecting a session's journal into a
summary and streaming it to subscribers. On every publish it additionally
ingests the summary into the hook server as a status row:

| Row field                                           | From                                                                                                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `paneKey`                                           | `structuredAgentSessionPaneKey(tabId, sessionId)`, the key the renderer already uses; its leaf is UUID-shaped so pane-key validation accepts it |
| `tabId`                                             | `structuredAgentSessionTabId(sessionId)`                                                                                                        |
| `worktreeId`                                        | `summary.workspaceId` (a folder workspace id is a valid value)                                                                                  |
| `state`                                             | `structuredAgentSessionStatusState(summary.status)`, the mapping #19217 shared                                                                  |
| `structuredHost`                                    | `'owned'` while `summary.hostExecutionOwned` is set, otherwise `'held'`; `worktree ps` derives its row's `structuredHostOwned` from it          |
| prompt, tool, last message, model, provider session | the summary's fields                                                                                                                            |

Sessions with no persisted turn (`status === null`) produce no row, matching
what the chat shows. When the host revokes live ownership the row is re-set
without the flag; when the host closes or evicts the session the row is
dropped. Both already exist as feed events (`revokeLive` and the roster
filter in `liveSessionSummaries`); PR 1 turns them into store writes.

Dropping the session from the host's map and dropping its row are one
operation, `forgetStructuredAgentSession`. The store keeps a row until told,
and a host-owned row bypasses the staleness check, so a deletion path that
forgot the row would strand a permanently working-looking agent.

Two rules the ingest must keep:

- **Never persist a structured row.** The journal is the durable truth for a
  structured session and the host republishes on restore. A structured row in
  `last-status.json` would hydrate as `restoredUnconfirmed` and then fight the
  live republish. The serializer skips rows carrying `structuredHost`, and
  hydrate drops any such row found on disk. Applying one therefore also skips
  the persist schedule: the walk and stringify could only reproduce the file
  that is already on disk, once per debounce window for every streaming chat.
- **Never let it fight a hook row.** A structured session has no PTY, so no
  hook or OSC event carries its pane key. The ingest still goes through the
  disposition gate so a retired pane key is refused like any other.

Applying one does still run both status fan-outs, and that is intended rather
than incidental. `notifyStatusChangeListeners` is what feeds
`agentAwakeService`'s power-save blocker, and `subscribeEnrichedStatus` is what
feeds `AgentSessionTransitionRecorder`'s stats, so joining the store enrolls
native chats in both. A working native chat is real work and should hold the
machine awake exactly like a PTY agent does.

The drop side routes through `dropStatusEntry`, not `clearPaneState`: a
pane-status-clear reaches the renderer, and until PR 2 the renderer's own feed
bridge is that pane key's writer. It also passes `preserveResumeIdentity:
false` — the `providerSessionOnly` remnant a dismissed pane keeps exists so the
agent can be resumed in that pane, and a structured session has no pane and
keeps its resume identity in the record store. Like every other
`dropStatusEntry` caller, it emits no pane clear, so a session dropped
mid-`working` leaves `AgentSessionTransitionRecorder` holding an open stats
session until its LRU evicts it; that gap is shared with the user-dismissal
path and is not specific to structured rows.

The ingest lives in the feed, not in `structured-agent-session-host.ts`, which
sits at the file-length cap.

### `worktree ps` becomes a reader

The structured adapter added in #19217 is deleted, and structured rows reach
`worktree ps` through the same snapshot as every other row. The
retained-versus-hook reconciliation in `collectRuntimeWorktreePtyAgentSources`
stayed until PR 1b removed the store that fed it. What this step settles is
the admission gate that decides which rows a worktree listing may show:

- a hook or OSC row needs its tab mirrored or a connected pty, as today, and
  SSH rows stay exempt because their tabs may exist only remotely;
- a row carrying `structuredHost` is admitted while the host holds the session, and
  the host's drop on close is what removes it. No tab-mirror requirement: a
  structured session's tab lives in the renderer's own tab state, and a
  headless host has no renderer to mirror it from. That argument only holds if
  the headless host is itself wired to the store, which is a separate
  obligation per entry point: the Electron hosts (desktop and `orca serve`)
  share `main-process-runtime-service.ts`, and `orcad` constructs its own
  runtime in `src/main/orcad/orcad-entry.ts`. A host missing that wiring lists
  no agents at all, not just no structured ones, because `worktree ps` reads
  the same snapshot for every row.

The freshness bypass for host-owned structured rows already exists in
`isFreshNonDoneAgentStatus`; with the flag now on the row it becomes the only
path, and the hand-rolled check in `runtime-worktree-agent-rows.ts` goes.

### Wire compatibility

`AgentStatusIpcPayload` gains one optional field, `structuredHost`, and the
`worktree ps` row gains `structuredHostOwned`. Under rule 1 of
[`remote-wire-compatibility.md`](./remote-wire-compatibility.md) both are safe:
an old client ignores them. `worktree ps` rows keep their shape and vocabulary,
so the mobile app sees no change.

Until PR 2 the main process does not forward structured rows to the renderer
over `agentStatus:set` or `agentStatus:getSnapshot`. The renderer's feed
bridge still writes those rows itself, and forwarding them too would give one
pane key two writers. Removing that filter is the first step of PR 2.

## PR 1b: the runtime's retained row store is deleted

Landed. `RuntimeAgentRowStore` is gone, and with it the retained-versus-hook
reconciliation in `collectRuntimeWorktreePtyAgentSources`. The hook server's
store is now the only main-process copy of a PTY agent's row.

### The five call sites

| Call site                                                                      | Before                                                          | After                                                                                              |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `orca-runtime-create-terminal-side-effect-command-code-detector.ts` `retain()` | second write of the OSC payload already sent to the hook server | deleted; the event now carries the pane's `terminalHandle` and the hook ingest keeps the only copy |
| `...command-code-detector.ts` `clearPty()`                                     | drops rows on pty exit                                          | deleted; pane teardown already clears the hook row                                                 |
| `orca-runtime-get-worktree-ps.ts` `values()`                                   | fed `retainedSnapshots`                                         | deleted; the reader keeps only `hookSnapshots`                                                     |
| `orca-runtime-serialize-agent-prompt-submission.ts` `getFreshExplicit()`       | retained row first, hook rows second                            | `selectFreshExplicitAgentStatus`, hook rows only                                                   |
| `orca-runtime-prune-mobile-session-tab-group-layout.ts` `getFreshForMobile()`  | pane key, then pty id                                           | `selectFreshAgentRowForMobileTab`: pane key, then `terminalHandle`                                 |

Both readers moved into `runtime-hook-agent-row-selection.ts`, which also owns
`RuntimeAgentRowSnapshot` now that nothing retains one.

### `terminalHandle` is the row's join back to its terminal

The retained store's only real extra was the pty id, and two readers used it.
The plan said to stamp the event's `ptyId` into `terminalHandle`; that was
wrong. A terminal handle (`term_<uuid>`) and a pty id are different
identifiers, and `getFreshExplicit` was already comparing hook rows against a
real handle. What landed instead:

- `AgentHookEventPayload` and the runtime's terminal-status event gained an
  optional `terminalHandle`. The detector resolves it once per chunk through
  `getAgentStatusTerminalHandleForPaneKey` — the same lookup the renderer-facing
  IPC boundary already runs for every row, so the two surfaces cannot disagree
  about which terminal a pane is.
- `applyNormalizedStatus` carries the handle forward when an incoming event
  resolves none. Only main's OSC parse can resolve one, so an HTTP hook post for
  the same pane would otherwise erase it.
- It is never persisted. A handle belongs to the runtime that issued it, and a
  hydrated one could only rejoin a row to somebody else's terminal.
- `toAgentStatusIpcPayload` publishes it, which also makes `getFreshExplicit`'s
  long-dead handle comparison live: the runtime reads raw snapshot rows, and
  before this nothing ever stamped the field on them.

`worktree ps` uses it too. `ConnectedPtyEvidence` traded its flat `ptyIds` set
for `ptyIdByTerminalHandle`, so a row still resolves the connected PTY behind
it — which is both the working-terminal rollup's match key and the last rescue
for a row whose pane binding was nulled by a controller incarnation change.

### The change detector had to move with the store

`retain()` was not only a store: its boolean return was the signal that
republished `session.tabs` for a status-only transition, which no title change
covers (#7970). `hook-status-session-tabs-invalidation.ts` already mirrors that
projection change set, including restore provenance and terminal-handle joins,
so the replacement was to route the signal off the store rather than build a
second comparator.
`installHookStatusSessionTabsRepublish` now owns all three arms — enriched
status, pane clear, and the status-drop tap a dismissal emits — and both hosts
install it.

### Both hosts, not just the desktop one

`orcad` constructed its runtime with no `onTerminalAgentStatus`, so main's OSC
parse never reached the store there and the retained copy was the only carrier.
Deleting it without wiring orcad would have made a headless host list no PTY
agents at all. `orcad-entry.ts` now binds the producer and installs the
republish signal, alongside the snapshot and structured sink it already had.

### The intended behavior change

A row the user dismisses on the desktop leaves `worktree ps` and the phone at
once, instead of lingering until the pty exits. One store means one dismissal.

Legacy numeric pane keys remain a bounded compatibility case. Persisted layouts
register aliases to their stable leaf owners; an in-process OSC observation may
also retain a numeric key only when the runtime supplies the matching tab, PTY,
and terminal handle. HTTP and relay ingress still require a stable key or a
registered alias, and numeric rows are never persisted.

## PR 2: the renderer subscribes

With structured rows arriving over `agentStatus:set`, the renderer's
`StructuredAgentSessionStatusBridge` no longer needs to write status; its
unmount cleanup becomes a tab-close signal to the host. The IPC applicator is
the single writer for observed status. The 2026-09-09 audit sorted the other
writers:

| Writer                                                            | Disposition                                                                                              |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Command Code output seeds, parked-pane seeds, pty-exit removal    | delete; main already emits the same facts                                                                |
| structured bridge status writes                                   | delete; main now publishes the row                                                                       |
| launch placeholder seeds (a user launched an agent with a prompt) | keep for now; main holds the launch config and can seed later                                            |
| dismissal, acknowledgement, unmount                               | keep; user facts and component lifecycle                                                                 |
| remote-runtime OSC parse (bytes never transit local main)         | keep, fenced behind the host's published row once the host is new enough; rule 3 of the wire doc applies |
| web-session mirror receipt clock                                  | keep; the decay rule needs both clocks from one machine                                                  |

The Command Code done-settle window is renderer policy with no main
equivalent. PR 2 either moves it into main's detector or leaves it, and says
which.

## PR 3: one rollup, one clock

The worktree card status is derived three times: `lib/worktree-status.ts` in
the renderer, `runtime-worktree-status-projection.ts` in main, and
`agent-row-display.ts` in mobile, which hand-copies the 30-minute constant.
PR 3 moves the rollup and the decay into `src/shared` and makes all three
call it.

## What does not change

- The hook scripts, the OSC 9999 wire format, and the relay protocol.
- The status vocabulary. `working / blocked / done` for rows,
  `working / attention / idle` for structured summaries, mapped once.
- The `live / unverifiable / exited` verdicts for remote work. Loss of contact
  clears nothing; the SSH exemptions in the admission gate stay.
- Hydration honesty: a restored non-done row is `restoredUnconfirmed` and is
  never fresh.

## PR 1b reliability contract

- **Invariant (`agent-session.status-host-ownership`):** each execution host has
  one agent-status store; OSC, hooks, and structured sessions write it, while
  desktop, `worktree ps`, and mobile only project it. Dismissal, certified PTY
  exit, and provider-generation replacement remove the same row everywhere;
  transport loss alone removes nothing.
- **Failure source:** the deleted runtime row store duplicated OSC observations,
  keyed them by a different terminal identity, and outlived a dismissal from the
  hook store. Relay replay could also make old evidence look fresh when readers
  used its new delivery timestamp.
- **Oracle:** one OSC observation appears through the hook snapshot in
  `worktree ps` and mobile, and one store dismissal removes it from both without
  stopping the PTY. Focused tests also require leaf/incarnation-handle rejoin,
  legacy numeric-pane compatibility, certified-exit and provider-generation
  cleanup, evidence-age freshness, and exactly-once startup/stop teardown.
- **Gate:** `terminal-performance.osc-status-scan-budget` covers the unchanged
  bounded OSC parser and the runtime projection. There is not yet a dedicated
  blocking multi-surface status-store gate; the focused suites below are the
  accepted gap until they accumulate reliability-gate soak evidence.
- **Provider/platform coverage:** local and daemon-backed PTYs are covered by
  runtime tests, and SSH relay loss/replay semantics by relay integration tests.
  The projection is shared by git worktrees and folder workspaces. WSL uses the
  same store and admission code but has no live run here; Linux and Windows
  runtime execution, native mobile clients, and mixed-version paired clients
  remain validation gaps.
- **Performance budget:** publication stays event-driven with no new polling or
  subprocesses. One mobile projection clones the status snapshot once, builds
  pane/handle indexes once, and has a deterministic call-count test; lifecycle
  cleanup is bounded by the existing status and handle inventories, and orcad
  tests prove listeners clean up once on failed startup and repeated stop.
- **Diagnostics:** existing hook-listener errors name the pane and PTY, while
  status-store tests pin delivery versus evidence clocks. No new telemetry or
  raw terminal data is emitted.
- **Residual gaps:** rendered Electron/mobile behavior, live SSH reconnect, and
  Linux/Windows/WSL execution require the platform QA pass. The current
  cross-version gate does not cover `session.tabs` content.

## Verification

- Unit: ingest a structured summary and read it back through
  `getStatusSnapshot`, `worktree ps`, and the mobile projection; assert the
  serializer never writes a row carrying `structuredHost`; assert a hydrated
  file that somehow contains one is dropped.
- Unit: the `worktree ps` suites written against the retained store are rewired
  to a real `AgentHookServer` (`agent-status-store-wiring.test-fixture.ts`)
  rather than deleted, so each still asserts the listing behavior it named. The
  dismissal change is pinned end to end in
  `orca-runtime-tests/worktree-ps-agent-row-dismissal.spec.ts`, which fails with
  the retained store restored.
- Live: the parity check from #19217 (working, done, close, reload) repeated
  against the merged store, with both surfaces read from the one row.
