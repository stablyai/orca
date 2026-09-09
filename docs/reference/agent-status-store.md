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
the step that delivers them; PR 1a, PR 1b, PR 2a and PR 2b have landed.

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

| Row field                                           | From                                                                                                                                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paneKey`                                           | `structuredAgentSessionPaneKey(sessionId)`, the key the renderer also derives (PR 2a made it take the session id alone); its leaf is UUID-shaped so pane-key validation accepts it |
| `tabId`                                             | `structuredAgentSessionTabId(sessionId)`                                                                                                                                           |
| `worktreeId`                                        | `summary.workspaceId` (a folder workspace id is a valid value)                                                                                                                     |
| `state`                                             | `structuredAgentSessionStatusState(summary.status)`, the mapping #19217 shared                                                                                                     |
| `structuredHost`                                    | `'owned'` while `summary.hostExecutionOwned` is set, otherwise `'held'`; `worktree ps` derives its row's `structuredHostOwned` from it                                             |
| prompt, tool, last message, model, provider session | the summary's fields                                                                                                                                                               |

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

PR 1a did not forward structured rows to the renderer over `agentStatus:set` or
`agentStatus:getSnapshot`: the renderer's feed bridge still wrote those rows
itself, and forwarding them too would have given one pane key two writers.
PR 2b removed both filters.

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

## PR 2a: converge the two derivations before the filter comes off

PR 1a left main and the renderer each deriving a structured row from the same
host summary, which is safe only while the IPC filter keeps them apart. This
step closed both divergences so PR 2b can remove the filter without one session
rendering twice or its clock jumping. No filter came off here and no writer was
retired.

### The pane key is derived from the session id alone

`structuredAgentSessionPaneKey` now takes the session id and nothing else, and
builds `structuredAgentSessionTabId(sessionId)` itself. Main's key is unchanged;
the renderer's three call sites (the status bridge's write and its unmount
cleanup, and `NativeChatStructuredSession`'s read) stopped passing `tab.id`.

The tab id was the wrong input, but not a simply wrong one: the trade is real in
both directions, and the section below on readers is the other half of it.
`web-session-tabs-sync/terminal-surfaces.ts` re-hosts a mirrored session at
`${baseId}:history-N` when its derived id is already occupied, and the host never
sees that suffix. Two things followed from keying on it, and both are fixed:

- the renderer and main wrote different keys for one session, so removing the
  filter would have produced two rows for one chat;
- the key held a second `:`, which `parsePaneKey` rejects. An unparseable key is
  dropped by `buildWorktreeAgentRows` (both the `entriesByTabId` bucket and the
  worktree-attributed fallback), so a surface re-hosted at `:history-N` published
  a key no reader could bucket. It now publishes the session's key like any other
  surface.

  That is narrower than a session gaining a row it did not have. The suffix is
  only assigned when the base id is already occupied, and the occupant is
  normally the same session's other surface — which was already publishing the
  base key, and whose row the suffixed surface now shares rather than adds to.
  The bridge test for a disambiguated mirrored surface pins the derivation, not
  a reachable end state: its fixture has a suffixed surface with nothing at the
  base id, which `buildMirroredAgentTabs` does not produce. Read it as a guard
  on the key, not as evidence of a row the user gains.

Nothing was stranded under an old key: main never wrote a suffixed key, and the
renderer's `agentStatusByPaneKey` is in-memory, so a `:history-N` row only ever
lived as long as the window that wrote it — and it was invisible while it did.

One surface behavior needed handling. Two tabs can transiently mirror one
session (the collision that produces the suffix), and they now share one key, so
the status bridge's unmount cleanup no longer clears the row while another
surface still mirrors that session.

### What this converged, and what it did not

The key is now derived from the session id. What the key is derived _from_ is
not: on the replacement path the renderer's local tab id still trails the **old**
session, so the session id in the key and the session the surface actually hosts
disagree. So "the tab id was the wrong input" is only half the story — the tab id
is wrong because the renderer lets it go stale, and 2a converged the key without
converging that.

The host does not have this problem, because it re-keys. `replaceConversationInSnapshot`
(`src/main/runtime/structured-conversation-tab-replacement.ts`) sets the tab's id
to `agent-session:${replacement.sessionId}` and renames every reference that held
the old one — `activeTabId`, and each group's `tabOrder`, `activeTabId` and
`recentTabIds`. `terminal-surfaces.ts` instead reuses `existing?.id`, so the
renderer is the outlier. `/clear` and `/compact` are what mint a replacement
session id, so this is a routine action, not an edge case.

That leaves two readers to fix here, and a re-key to do elsewhere.

### The key names the session, so readers resolve the surface by session

A structured pane key's tab-id half is `structuredAgentSessionTabId(sessionId)`,
not the id of the surface hosting the chat. Two readers were using it as surface
routing, and `terminal-surfaces.ts` breaks that agreement in both of its
id-collision paths — a conversation that _replaces_ another reuses the superseded
tab, so the local id keeps spelling the old session while `entityId` becomes the
new one:

- `WorktreeCardAgents`'s row click resolved the tab by exact id, so a replaced
  conversation's row did nothing at all. It now falls back to
  `activateStructuredAgentSessionForRow`, which reads the session id back out of
  the tab id (`structuredAgentSessionIdFromTabId`) and resolves the surface by
  `entityId`.
- the live-entry worktree index in `worktree-agent-row-selectors.ts` maps tab id
  to worktree, and a `done` row is bucketed only through that index (a live row
  still has `entry.worktreeId` to fall back on). A replaced conversation's
  settled row therefore vanished from the sidebar. The index now registers each
  agent-session tab under its derived session tab id as well as its local id.

`structured-agent-session-projection.ts` owns both directions of the derivation,
so no reader re-spells the prefix.

This is the invariant guard, not a substitute for the re-key below: it resolves
from the pane key, never from `entry.tabId`, so PR 2b making main the sole writer
of that field does not decay it — and it covers the `:history-N` surface, which a
re-key cannot, because the suffix exists precisely when the derived id is taken.

### For the re-key PR: what was already measured

Making the renderer's tab id follow the session, as the host's does, is the
durable fix and belongs in its own PR ahead of this one. It was probed against
`structured-conversation-tab-replacement.test.ts` and the `web-session-tabs-sync`
suites (28 files / 249 tests green at the baseline) and then reverted. Do not
re-derive this:

- **Re-keying alone breaks focus continuity.** `resolveWebSessionVisibleTabId`
  (`web-session-focus-intent.ts`) matches the sticky visible tab by exact id and
  then falls back to `entityId`. A replacement changes both, so it resolves to
  null and `nextActiveUnifiedTabId` falls through to the first agent tab in
  snapshot order — in the `history: 'before'` variants that is the reopened
  archive, so `/clear` leaves the user looking at the old conversation. The id
  carry-forward is load-bearing for focus, which is why the code does it.
- **The repair channel already exists.** `apply-preparation-groups.ts` builds
  `rekeyedTabIds` for exactly this ("an entity-identical replacement ... is a
  rename — its position and focus must carry over") and already feeds it from
  provisional-terminal and local-editor renames. Adding agent tabs to it restored
  correct focus in all six variants; 5 of 7 cases then pass.
- **Residue to cover with its own test:** `activeTabIdByWorktree` lands on the
  reopened history tab in the two agent-session × history-present variants. All
  three `terminal` variants pass.
- **`layoutByWorktree` is not at risk.** `TabGroupLayoutNode` holds `groupId`,
  never tab ids, so persisted layouts survive a re-key untouched.
- **It would remove the main source of `:history-N`.** The suffix exists because
  the replaced tab squats on `structured-agent-session-<old>`; freeing that id
  gives the reopened history tab its natural one.
- The replaced-conversation fixture in
  `components/sidebar/replaced-structured-session-agent-row.test.tsx` retargets to
  `applyWebSessionTabsSnapshot` for that PR rather than needing a new one.

The contract that PR rewrites is `clear pane identity`, seven pinned cases
covering agent-session **and** the terminal→chat conversion (`contentType:
'terminal'` with `structuredSessionId`, where the reused surface is a terminal
holding `ptyIdsByTabId`, `terminalLayoutsByTabId` and `runtimePaneTitlesByTabId`).
That is why it is not a rider on a status-row refactor.

### `stateStartedAt`: the renderer stops overriding the store's rule

A row's `stateStartedAt` is the start of the state the row is in, so republished
evidence never moves it and only a state change (or Command Code's same-state
new turn) resets it. `attachStatusTiming` had this rule already, and so did the
renderer store's own default in `agent-status-live-entry-builder.ts` — including
the Command Code clause, which it computes internally.

The divergence was that the bridge's `projectStatus` _passed_ a
`timing.stateStartedAt`, which is exactly the override that displaces that
default, and the value it passed carried an extra `desired.state !== 'done'`
clause that restamped a settled row on every republish. The bridge now passes no
`stateStartedAt` at all, so the store applies its own rule. There is no shared
helper: one would have had a single caller, and it could not express the store's
Command Code clause from the bridge's call site. `server-reaping.ts` still holds
its own inline copy of the same shape, so "one rule for every writer" would not
have been true either.

`done` is not an exception, because `agentEntryCompletionAt` reads a settled
row's `stateStartedAt` as its completion time. A moving one re-dates a turn that
already finished, and `smart-attention` already documents the opposite
expectation for hook rows: same-state `done` writes advance `updatedAt` without
moving the completion.

The visible effect is narrower than this document first claimed. `stateStartedAt`
reaches `NativeChatResolvedView`'s `hookWorkingEpoch` and
`NativeChatWorkingStatus`'s elapsed time, but both are read only while the row is
`working`, where the two rules already agreed. What changes is Class 2 ordering
in the sidebar and dashboard: a settled structured session whose journal keeps
moving now sorts by when it finished rather than by its latest journal write.

## PR 2b: the renderer subscribes

Landed. Both filters are gone, the IPC applicator applies the host's structured
rows, and `StructuredAgentSessionStatusBridge` no longer projects status for a
locally hosted session.

### The two filters this step removed

- `main/startup/main-window-agent-status.ts` — the `if (structuredHost) return`
  guard above the `agentStatus:set` sends. It sat above BOTH the main window and
  `getDashboardPopoutWindow()`, so removing it is also what first gives the
  dashboard popout structured sessions.
- `main/ipc/agent-hooks.ts` — the `.filter((entry) => entry.structuredHost === undefined)`
  on `agentStatus:getSnapshot`, which is the pull a renderer does after
  hydration. Without it a native chat had no row until its next journal edge, and
  a settled one never came back at all.

Two things the window listener now skips for a row carrying `structuredHost`,
neither of which the plan anticipated:

- `maybeAutoRenameBranchOnFirstWork`. First-work branch rename is a PTY-agent
  feature whose structured-session gap is tracked on its own; publishing the row
  must not switch it on half-covered as a side effect.
- `driveSyntheticTitleFromHook`. It injects a title into a pane's title slot, and
  a structured session has no pane.

### Removing the filters was not enough on its own

The plan treated this step as a switch flip. It is not: a structured pane key
resolves to no entry in the renderer's terminal-tab routing index, because an
`agent-session` tab lives in `unifiedTabsByWorktree`, not `tabsByWorktree`. The
applicator's `exists` gate therefore held every published structured row as
`pending` forever — main would have published rows the renderer dropped on the
floor, with every test still green.

`ipc-events/structured-agent-session-row-routing.ts` is what closes that. It
resolves a structured row against the `agent-session` tab, matching either the
tab's own id or the id derived from its `entityId`, so a `:history-N` mirrored
surface still matches.

That tab is REQUIRED — deliberately narrower than the admission rule
`worktree ps` uses, which lists a session the host holds whether or not a surface
is open. Two reasons:

- it is what the renderer already showed. The bridge this replaces only wrote a
  row for a mounted `agent-session` tab, so requiring one keeps sidebar
  visibility unchanged rather than adding rows as a side effect of the flip;
- a terminal tab in chat view mode is backed by a structured session too
  (`TerminalPaneNativeChatPortal`), and its own pane already has a row.
  Admitting the host's row for that session as well would put two rows in the
  sidebar for one tab. `worktree ps` has carried that pair since PR 1a; the
  sidebar must not inherit it here.

It also resolves the row's title from that tab. The wire deliberately carries no
title — naming a structured session is a separate lane — but the sidebar
synthesizes a tab for a paneless row (`worktree-agent-row-fallback-tab.ts`) and
names it `'Agent'` when the entry has none. The plan's reading that
`worktree-agent-row-type.ts` would fall back to `tab?.title` was about
AGENT-TYPE resolution, not the row's name, and it does not apply here: a
structured session has no `TerminalTab` at all. Reading the label in the renderer
keeps today's behavior without teaching main a name or putting one on the wire.

### The four fields the bridge wrote that main's ingest does not

- `terminalTitle` — resolved renderer-side from the session tab, as above.
- `structuredHostOwned` — the wire spells it `structuredHost: 'owned' | 'held'`,
  and the applicator maps it back. It is the freshness bypass in
  `shared/agent-status-freshness.ts`; without the mapping every native chat that
  works for over half an hour decays to idle in the sidebar.
- `terminalResumeEligible: false` — kept, derived from `structuredHost` being
  present at all. `agent-status-sleeping-records.ts` reads it: a structured row
  carries a `providerSession`, so without this Orca mints a sleeping record and
  offers to relaunch a native chat as a TUI.
- `allowOlderTimestamp` — dropped. The bridge needed it because it stamped the
  journal clock as `updatedAt`, which a legacy publication can move backwards.
  Main stamps `receivedAt = Math.max(Date.now(), watermark + 1)`
  (`server-status-update.ts`), so the applicator's `data.receivedAt <
existingStatus.updatedAt` ordering check can never see a host row go backwards.
  The journal clock still reaches the row, as `evidenceObservedAt`.

### The unmount cleanup stays, and the plan's reason it could go is wrong

The plan said the bridge's unmount cleanup becomes a tab-close signal to the
host. That signal already exists — `tab-group/workspace-tab-close-commands.ts`
calls `agentSession.close`, which reaches `forgetStructuredAgentSession` — but
sending it is not enough. The host drops its row through `dropStatusEntry`, which
notifies `subscribeStatusDrop` subscribers inside main and emits NO renderer
clear (only `clearPaneState` does, and the renderer's clear handler skips a row
already reading `done`, which is how a settled session ends). Deleting the
unmount write would therefore have left a ghost row in the sidebar for every
closed chat until the next reload.

So the removal stays, for the local lane as much as the remote one. It is the
"unmount" row of the disposition table, not a status write. A projection unmounts
when its tab leaves the tab map — a close or a host retraction — not on a
worktree switch: the bridge maps over every structured tab in every worktree.

### The bridge is retired for local sessions only

One store per execution host. A session on a REMOTE runtime is projected into
that host's store, and nothing mirrors structured rows down — the web-session
mirror carries terminal surfaces and their `agentStatus`, and an `agent-session`
surface in that snapshot has no status field. Deleting the bridge outright would
have left every remote native chat with no sidebar row.

So the bridge's STATUS WRITES are fenced on `target.kind === 'local'`: for a
local session it opens no feed and projects nothing, and for a remote one it
stays that session's writer, exactly as the disposition table already says for
the remote-runtime OSC parse. That is rule 3 of
[`remote-wire-compatibility.md`](./remote-wire-compatibility.md) — the fence
comes off when a remote store's rows are mirrored down, which is separate work.

### The disposition table, corrected

| Writer                                                            | Disposition                                                                                              |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| structured bridge status writes, local sessions                   | deleted; main publishes the row                                                                          |
| structured bridge status writes, remote sessions                  | kept; nothing mirrors a remote host's structured rows down                                               |
| structured bridge unmount removal                                 | kept for both lanes; `dropStatusEntry` emits no renderer clear                                           |
| Command Code output seeds, parked-pane seeds                      | NOT deleted — see below                                                                                  |
| pty-exit removal                                                  | NOT deleted — see below                                                                                  |
| launch placeholder seeds (a user launched an agent with a prompt) | keep for now; main holds the launch config and can seed later                                            |
| dismissal, acknowledgement, unmount                               | keep; user facts and component lifecycle                                                                 |
| remote-runtime OSC parse (bytes never transit local main)         | keep, fenced behind the host's published row once the host is new enough; rule 3 of the wire doc applies |
| web-session mirror receipt clock                                  | keep; the decay rule needs both clocks from one machine                                                  |

The audit's "main already emits the same facts" was true of the word FACTS and
false of the store:

- **Command Code output seeds and parked-pane seeds.** Main's detector
  (`orca-runtime-create-terminal-side-effect-command-code-detector.ts`) calls
  `recordTerminalSideEffectFact(ptyId, { kind: 'command-code-working' | 'command-code-done' })`.
  That fact travels to the RENDERER, where
  `terminal-side-effect-facts-handler.ts` turns it into the store write. Nothing
  in main puts it in the hook server, and the write is gated on
  `canCommandCodeOutputOwnPane`, which reads `paneForegroundAgentByPaneKey`,
  `retainedAgentsByPaneKey` and `agentLaunchConfigByPaneKey` — renderer state
  main does not have. Command Code has hooks for PreToolUse/PostToolUse/Stop but
  no prompt-submit hook, which is why the scrape exists at all. Deleting these
  seeds without first building a main-side ingest would leave Command Code with
  no working row. That ingest is a producer-routing change, PR-1 shaped, not part
  of "the renderer subscribes".
- **pty-exit removal** (`pty-connection/pty-exit-hibernate.ts`). Every
  attributable exit reaches `clearProviderPtyState` -> `clearPaneState`, which
  does emit a renderer clear. But `server-cleanup.ts` documents the case that
  resolution misses: a restored or reattached PTY may never rebuild the
  spawn-time `ptyPaneKey` mapping, and those panes "keep a `working` row and its
  latches for good". The renderer's own removal is the last thing retiring them.

### The Command Code done-settle window stays in the renderer

It is left where it is. Moving it into main's detector only makes sense together
with a main-side Command Code status ingest — the window exists to decide when a
row completes, and main writes no such row today. Moving the timer without the
row would put the deadline on one side of the process boundary and the write on
the other. It is the same deferral as the item above, and belongs with it.

### What "one writer" actually means after this

Not zero renderer writers. The IPC applicator is the single writer for OBSERVED
status on a locally hosted structured session; the table above keeps the rest on
purpose. Of those, only the launch placeholder seeds are a deferral rather than a
principle — main holds the launch config and could seed them.

### Ordering

Depended on PR 2a: with the two derivations disagreeing, removing these filters
rendered one session twice and shifted the chat's elapsed clock.

## PR 3: one rollup, one clock

The worktree card status is derived three times: `lib/worktree-status.ts` in
the renderer, `runtime-worktree-status-projection.ts` in main, and
`agent-row-display.ts` in mobile, which hand-copies the 30-minute constant.
PR 3 moves the rollup and the decay into `src/shared` and makes all three
call it.

### The three copies

| Copy | Lines | Reads |
| --- | ---: | --- |
| `renderer/src/lib/worktree-status.ts` | 222 | the sidebar store |
| `main/runtime/runtime-worktree-status-projection.ts` | 255 | the hook snapshot |
| `mobile/src/worktree/agent-row-display.ts` | 118 | `worktree ps` rows |

The mobile copy hand-copies the 30-minute constant rather than importing
`AGENT_STATUS_STALE_AFTER_MS`, so the three can drift by edit as well as by
logic. `isFreshNonDoneAgentStatus` in `shared/agent-status-freshness.ts` is
already shared and is the model: the rollup should sit beside it.

### Why this is last

Only after PR 2b do all three read equivalent rows. Sharing the rollup before
that would unify the arithmetic over inputs that still disagree, which hides
the disagreement rather than removing it.

### Watch item

Mobile currently ignores `structuredHostOwned`, so an owned structured row
decays to idle there while the desktop keeps it. That is pre-existing, not a
regression from PR 1a, and this step is where it stops being true — the shared
rule already handles the owned case.

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
