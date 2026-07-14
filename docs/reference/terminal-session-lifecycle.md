# Terminal Session Ownership and Teardown

**Status:** Incident fix and pane-authority transfer implemented
**Date:** 2026-07-13
**Incident:** [`../../pty-exhaustion-agent-session-leak.md`](../../pty-exhaustion-agent-session-leak.md)
**Related contracts:** [`terminal-model-view-contract.md`](./terminal-model-view-contract.md),
[`terminal-hidden-view-parking.md`](./terminal-hidden-view-parking.md)

## Summary

Terminal process lifetime must be owned by explicit product intent, never by
whether a React view happens to be mounted.

Orca currently preserves a PTY when a terminal view detaches, which is correct
for view parking, tab moves, renderer reload, and warm reattach. It also relies
on `TerminalPane` unmount to destroy a PTY after a tab is closed. Hidden-view
parking invalidated that implicit invariant: a parked tab has no mounted pane,
so closing it removes renderer state and observers without terminating the PTY.
Agent resume records survive the same close and later interpret the missing pane
as failed recovery, launching the deliberately closed session again.

This design establishes one authoritative lifecycle contract:

- **Close tab or pane:** permanently retire the surface, terminate every PTY it
  owns, and revoke every resume record for its panes.
- **Detach or park:** remove only the view connection; preserve the PTY and its
  durable identity.
- **Sleep:** intentionally checkpoint resumable agents, terminate the PTYs, and
  preserve only the checkpoint needed for wake.
- **Quit or reload:** follow the configured persistence policy; warm detach is
  allowed, but it is not a tab close.

The immediate implementation makes the existing terminal-tab state close the
authoritative compatibility boundary for explicit retirement while adding an
explicit natural-exit reason for callers that are only reconciling an already
dead PTY. A follow-up separates the command and reducer APIs once all direct
store callers have migrated.

## Implementation status

The incident patch ships the retirement planner, provider-aware close routing,
unified-only retirement, parked watcher/candidate disposal, resume-authority
revocation, explicit natural-exit handling, late-binding rejection, and direct
background-launch ownership checks. It also adds exact pane retirement and a
persisted physical-to-owner pane-key alias for detach, plus a live Electron
parked-close gate. Focused tests cover local, SSH, split, parked, shared,
paired-host, ordinary runtime, pane-transfer, and late-spawn paths.

Origin-aware defensive expiry remains a follow-up. Immediate deletion on
explicit close fixes the incident without applying a wall-clock policy that
could invalidate intentional long-lived `worktree-sleep` checkpoints.

## Goals

1. Closing a terminal tab submits retirement for all exclusively owned local,
   daemon, WSL, SSH, or runtime PTYs, including every split pane, whether its
   views are mounted or parked.
2. Closing a terminal pane terminates only that pane's PTY; detaching a pane to
   another tab preserves its PTY, hook identity, and resume authority under the
   new owning pane.
3. Closing a tab permanently removes its agent resume authority. App restart,
   worktree activation, mobile wake, and periodic capture must not resurrect it.
4. Parking, tab-group moves, renderer reload, and warm reattach keep their
   existing process-preservation behavior.
5. Remote-runtime and web-session surfaces are terminated by their owning host,
   not by sending a host-scoped ID to the local PTY provider.
6. Teardown is idempotent and safe under duplicate close requests, late PTY
   exits, late agent-hook events, in-flight spawns, and provider disconnects.
7. A future bookkeeping regression cannot grow without bound: unowned defensive
   resume records have an origin-aware expiry, and provider-owned detached
   sessions gain a bounded orphan policy in the daemon-lease phase.

## Non-goals

- Changing terminal output, snapshot, replay, query-response, or hidden-delivery
  behavior.
- Killing processes that deliberately daemonize away from the terminal process
  group. This contract covers the PTY and its attached foreground process tree.
- Changing agent-provider resume commands or permission flags.
- Making a UI close wait for a remote process to exit before the tab disappears.
- Replacing worktree sleep with tab close. Sleep remains resumable by design.
- Claiming that a disconnected SSH relay process is already dead when main can
  only tombstone its app-scoped ID. Durable relay-side kill-on-reconnect is a
  follow-up.

## Terminology

- **Surface:** a terminal tab or a pane within a split terminal tab.
- **View:** a renderer xterm or pane-less parked watcher observing a surface.
- **Session:** the provider-owned PTY identified by a PTY ID.
- **Resume authority:** a `sleepingAgentSessionsByPaneKey` record that permits
  Orca to launch an agent-provider resume command.
- **Retire:** permanently close a surface and revoke its process and resume
  ownership.
- **Detach:** disconnect a view while preserving the session for reattachment.

## Open-source prior art

The lifecycle distinction is established in mature terminal implementations:

- VS Code's terminal instance disposal calls process-manager disposal, and the
  process manager marks the process `KilledByUser` before shutdown. Its separate
  `detachFromProcess` path deliberately clears the client reference without
  shutting down the process. It also shuts down a process whose asynchronous
  creation completes after the manager was disposed. See
  [`terminalInstance.ts`](https://github.com/microsoft/vscode/blob/3f5c62a95ddb886424da463b41ac3ac5e45aa04f/src/vs/workbench/contrib/terminal/browser/terminalInstance.ts#L1287-L1325)
  and
  [`terminalProcessManager.ts`](https://github.com/microsoft/vscode/blob/3f5c62a95ddb886424da463b41ac3ac5e45aa04f/src/vs/workbench/contrib/terminal/browser/terminalProcessManager.ts#L207-L239).
- tmux exposes the same contract as separate commands: `detach-client` removes
  a client while leaving the session intact, whereas `kill-session` destroys
  the session and its windows. See
  [`tmux.1`](https://github.com/tmux/tmux/blob/42b3ea0d7411acb4cd0357a3c2829d986b455918/tmux.1#L1177-L1218).

Orca needs the same semantic split, extended across local, WSL, SSH, persistent
daemon, and remote-runtime ownership. The important precedent is the explicit
intent boundary, not a particular framework or process API.

## Non-negotiable invariants

1. View lifetime and process lifetime are independent. Mount and unmount may
   attach or detach observers; they do not decide whether a session should live.
2. Every live PTY has an owning surface or an explicit bounded detached state.
3. A user close is terminal: once accepted, no status event, session snapshot,
   or runtime replay may recreate the closed surface or resume its agent.
4. A tab's retirement candidates are the union of its live index, tab row,
   persisted split layout, last-known relay ID, deferred SSH ID, and pending
   reconnect ID. A candidate is killable only when no other live surface claims
   it.
5. Provider routing follows the execution owner:
   - local/daemon/WSL and app-scoped SSH IDs use `pty.kill`;
   - `remote:` runtime mirror IDs are never passed to the local PTY provider;
   - paired web tabs are closed through the host session RPC.
6. Teardown requests are idempotent. Repeated kill, exit-after-kill, and
   close-after-exit must converge on the same empty state.
7. Resume-record validity is origin-aware. Intentional `worktree-sleep` records
   are not expired by agent-status freshness; unowned defensive `live` and
   `quit` records use a documented decision-time horizon.
8. Natural process exit and explicit user retirement are distinct intents.
   Reconciliation after an exit must not silently adopt destructive user-close
   semantics.

## Lifecycle matrix

| Intent                | View                                       | PTY                                | Resume record                                       | Persistent tab state |
| --------------------- | ------------------------------------------ | ---------------------------------- | --------------------------------------------------- | -------------------- |
| Switch tabs/worktrees | hidden or parked                           | keep                               | keep/update                                         | keep                 |
| Move pane/tab group   | detach, then remount                       | keep                               | keep                                                | move                 |
| Renderer reload       | detach                                     | keep when warm persistence applies | keep                                                | keep                 |
| App quit              | detach or terminate per persistence policy | policy-dependent                   | capture live agents                                 | keep                 |
| Sleep worktree        | unmount                                    | terminate                          | capture intentional sleep checkpoint                | keep identifiers     |
| Close split pane      | destroy                                    | terminate that pane                | delete that pane record                             | remove pane          |
| Close terminal tab    | destroy or already absent                  | terminate all tab PTYs             | delete all tab records                              | remove tab           |
| Remove worktree       | destroy                                    | terminate all worktree PTYs        | delete all worktree records                         | remove worktree      |
| PTY exits naturally   | disconnect                                 | already dead                       | clear or retain completed evidence per agent policy | reconcile surface    |

## Current failure

The current close path deletes `ptyIdsByTabId[tabId]` and the tab layout, then
relies on a mounted `TerminalPane` cleanup to call `transport.destroy()`. A
parked tab has already run the detach branch and has no mounted cleanup left.
`disposeParkedTabWatchers` only unregisters observers. The provider session is
therefore alive after Orca discards its last renderer-side owner.

The same state close drops live agent status but not
`sleepingAgentSessionsByPaneKey`. Worktree activation intentionally fresh-resumes
records that no preserved pane can own. A deliberately closed pane therefore
looks like a failed restore. The existing age check compares `capturedAt` with
`updatedAt`; that detects a status that was stale at capture time but never
expires a record as wall time advances.

## Proposed architecture

### 1. Authoritative tab retirement plan

Before deleting any tab-scoped state, build a `TerminalTabRetirementPlan` from
one store snapshot:

```ts
type TerminalTabRetirementPlan = {
  tabId: string
  worktreeId: string | null
  ptyIds: string[]
  localOrSshPtyIds: string[]
  runtimeTerminals: Array<{ environmentId: string; handle: string }>
  sharedPtyIds: string[]
  paneKeys: string[]
}
```

`ptyIds` is the deduplicated union of:

- `ptyIdsByTabId[tabId]`;
- the tab row's legacy `ptyId`;
- every value in `terminalLayoutsByTabId[tabId].ptyIdsByLeafId`;
- `lastKnownRelayPtyIdByTabId[tabId]`;
- `deferredSshSessionIdsByTabId[tabId]`;
- `pendingReconnectPtyIdByTabId[tabId]`.

This snapshot must be built before any of those maps are pruned. PTY IDs are
classified structurally with `parseRemoteRuntimePtyId`, not by assuming a host
or platform from the current active workspace. Before shutdown, the planner
subtracts IDs referenced by another tab row, live index, split layout, or relay
and reconnect map. A partially completed pane move must not let closing the
source tab kill the target tab's session.

The immediate compatibility boundary is `closeTab`, because several production
paths still call the store action directly. Its options carry an explicit
`reason: 'user' | 'pty-exit' | 'cleanup'`; `user` and `cleanup` retire, while
`pty-exit` reconciles an already-dead session without killing siblings or
revoking crash-recovery policy by accident. Making only the rendered tab-bar
action destructive would leave background launch cleanup, floating terminal,
onboarding, runtime notifications, and future direct callers vulnerable.

### 2. Teardown ordering

A local tab retirement executes in this order:

1. Snapshot the retirement plan and its execution-owner classifications.
2. Mark the tab recently closed so late agent-hook events cannot reintroduce
   status or resume authority.
3. Dispose the whole tab's parked registry entry and captured candidates, and
   silence teardown side-effect handlers while preserving deterministic exit
   observation.
4. Submit `pty.kill` for exclusive local or SSH IDs and `terminal.close` for
   exclusive ordinary runtime handles. A paired host-session close remains
   owned by `session.tabs.close` and is not duplicated locally.
5. Atomically remove the tab, layout/binding maps, agent status, and resume
   records from renderer state.
6. Let subsequent React unmount cleanup run idempotently. It is no longer the
   process-lifetime authority.

Steps 3 and 4 are issued before the state loses its IDs. The UI state mutation
remains synchronous and does not await provider exit. Completion is observed
with `Promise.allSettled` so rejections cannot become unhandled promises. The
current Phase 1 fallback for a rejected retirement is provider `listSessions`
plus Resource Manager orphan cleanup; durable retry inventory belongs to the
main-owned retirement phase.

Remote-runtime mirrors are different: their `remote:` IDs are excluded from
local `pty.kill`. Ordinary runtime terminals retire through `terminal.close`.
Paired host-session tabs retire through `session.tabs.close`, which owns the
entire host tab graph. The local mirror may be pruned optimistically only after
the host close intent is recorded, as it is today.

### 3. Resume-authority revocation

Tab retirement removes every sleeping record whose:

- map key begins with `${tabId}:`; or
- record has `tabId === tabId`.

The explicit `record.tabId` check covers migrated or legacy keys whose key no
longer encodes the current tab identity. Sibling tabs and other worktrees retain
their records by reference when unchanged.

The existing recently-closed tab registry remains the short-lived race guard
for hook events already in flight. It must prevent those events from creating a
new `origin: 'live'` resume record after retirement. Tests must cover both event
orders: close then late status, and status queued in the same turn as close.

Periodic capture iterates only current live status entries. Once close removes
the live entry and resume record, the periodic pass has nothing to persist.

### 4. Origin-aware defensive record expiry

An unowned defensive `live` or `quit` record may expire when:

```ts
Date.now() - record.capturedAt > DEFENSIVE_AGENT_RESUME_MAX_AGE_MS
```

Intentional `worktree-sleep` records are exempt from the agent-status freshness
window. Originless legacy behavior remains unchanged until its migration policy
is explicitly chosen. The same validator must run before desktop activation and
mobile/background wake so one entry point cannot bypass it.

Expiry is defense in depth, not the primary close mechanism. A correctly closed
record is deleted immediately; it is not retained for 30 minutes.

### 5. Pane close remains pane-scoped

`PaneManager.closePane` already distinguishes `reason: 'close'` from
`reason: 'detach'`. Preserve that distinction with explicit pane authority:

- `close` must clear the exact pane's resume authority, add a pane-scoped late
  event tombstone, and destroy the pane transport;
- `detach` must atomically transfer or alias resume ownership because the agent
  process retains its immutable source `ORCA_PANE_KEY`.

The last-pane path routes to terminal-tab retirement so it receives the same
parked, split, SSH, and resume cleanup behavior as a tab-bar close.

### 6. Provider-side safety net

Client correctness is necessary but not sufficient for a daemon deliberately
designed to outlive renderer and app processes. Add a follow-up provider-owned
orphan policy:

- track attachments/ownership leases rather than treating `detach` as a no-op;
- distinguish warm-reattach grace from ownerless retirement;
- reap sessions that have no owner after a bounded grace period;
- never idle-reap a session merely because it produces no output;
- scope leases to native, WSL, SSH provider, relay connection, or runtime host;
- expose orphan count and oldest orphan age in Resource Manager diagnostics.

This hardening is not required to land the immediate close fix, because a lease
protocol changes daemon compatibility and needs its own migration. It is the
defense against a future client bookkeeping regression.

## Provider behavior

| Provider/session kind   | Close operation                     | Notes                                                                                          |
| ----------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| Local native            | `pty.kill(id)`                      | Main routes to the owning local/daemon provider.                                               |
| Persistent daemon       | `pty.kill(id)`                      | Explicit close overrides warm-reattach persistence.                                            |
| Windows ConPTY          | `pty.kill(id)`                      | Provider shutdown owns Windows process-tree semantics.                                         |
| WSL                     | `pty.kill(id)`                      | Route by PTY ownership; do not infer from path separators.                                     |
| SSH                     | `pty.kill(appScopedId)`             | Main resolves the connection-specific SSH provider.                                            |
| Disconnected SSH        | `pty.kill(appScopedId)`             | Tombstones locally and prevents fallback; relay-side death requires reconnect-aware follow-up. |
| Ordinary remote runtime | host `terminal.close`               | Classify environment and handle from the `remote:` ID.                                         |
| Paired web host tab     | host `session.tabs.close`           | Host owns the complete tab and pane graph.                                                     |
| Web client local mirror | optimistic prune after close intent | Host snapshot confirms final removal.                                                          |

## Failure and race handling

### Duplicate close

The first close snapshots and retires the tab. Later closes find no target and
no-op. Provider shutdown is idempotent for an already exited session.

### PTY exit races close

Observers are unregistered before shutdown. If an exit event was already
queued, the recently-closed tab guard and missing tab make it a no-op. It must
not recreate a tab, completion row, resume record, or notification.

### Spawn completes after close

The transport already kills a PTY when its spawn resolves after `destroyed` is
set, but the two direct background launchers do not use that transport. Each
direct launcher must revalidate tab ownership immediately after `pty.spawn` or
`terminal.create` resolves and before writing any binding, layout, eager buffer,
subscription, or mount request. A retired local or SSH result is killed; a
retired runtime result is closed through `terminal.close`.

### Provider shutdown fails

The tab remains closed; reappearing would violate user intent. Report the
provider class through structured diagnostics and leave the session visible in
provider inventory so existing Resource Manager orphan cleanup can retry. A
durable pending-retirement inventory is a later main-process API and is not
claimed by Phase 1. Do not restore resume authority after a failed terminal
kill.

### Remote host is unavailable

Keep the local close intent until either a host snapshot confirms removal or the
existing intent TTL expires. If it expires, the host remains authoritative and
may republish the tab; log the failed close. Never pretend a local mirror prune
terminated the host PTY.

### App exits during close

Submit shutdown IPC before discarding the only local PTY identifiers. The main
process/provider owns completion after accepting the request. A future batched
shutdown IPC may return per-ID acceptance, but UI close does not wait for it.

## Implementation plan

### Phase 1: correctness patch (implemented)

1. Add a small store-independent terminal-tab retirement planner that collects
   all six ID sources, classifies execution owners, and excludes IDs shared by
   another live surface.
2. Add an explicit close reason, update natural-exit callers, and make explicit
   `closeTab` retirement dispose the whole parked-tab registry, submit local,
   SSH, or runtime shutdown, atomically clear all reconnect maps, and remove
   tab-owned resume records.
3. Add post-await owner checks to both direct background launchers so a late
   local, SSH, or runtime spawn is terminated before any renderer binding.
4. Defer decision-time expiry until unowned defensive `live` or `quit` records
   can be distinguished without changing intentional `worktree-sleep` or legacy
   recovery behavior.
5. Add focused planner, store, launcher-race, and resume-policy tests. Keep one
   local Electron parked-close proof as an RC release gate.

### Phase 2: remaining API cleanup

1. Rename the state-only reducer primitive so `closeTab` cannot ambiguously mean
   either UI cleanup or lifecycle teardown.
2. Route all user and runtime close call sites through one domain command.
3. Keep explicit `detach` and `sleep` APIs; do not encode them as close options.
4. Add a development assertion when tab state is removed with provider PTY IDs
   but no retirement plan.

Exact pane retirement, persisted detach authority transfer, and unified-only
terminal routing landed with Phase 1 because exact-head review found they were
required to avoid introducing adjacent close regressions.

### Phase 3: daemon ownership leases

1. Define versioned attach/detach/retire lease messages.
2. Preserve warm reattach across renderer/app restarts within a bounded grace.
3. Reap ownerless sessions and expose pressure telemetry.
4. Add compatibility tests across the supported daemon protocol versions and
   native/WSL/SSH host isolation.

## Test plan

### Unit/store tests

- Closing an active single-pane tab submits exactly its PTY for shutdown and
  removes all tab state.
- Closing a parked tab with no mounted transport still submits its PTY.
- Closing a split tab submits every unique PTY found across tab row, index, and
  layout plus relay/deferred/reconnect maps, including IDs present in only one
  source.
- Duplicate IDs are submitted once by the authoritative retirement plan.
- An ID referenced by another live tab is not killed when the source tab closes.
- `remote:` IDs are excluded from local PTY shutdown.
- App-scoped SSH IDs are included and are not mistaken for remote runtime IDs.
- All sleeping records for the tab are removed by key prefix or `record.tabId`;
  sibling records retain identity.
- Periodic capture after close does not recreate the record.
- Late agent status after close cannot recreate live status or resume authority.
- Closing twice and close-after-exit are no-ops after the first retirement.
- A spawn resolving after close kills the newly returned PTY.
- A defensive live/quit record at the expiry boundary is retained; one
  millisecond past it is cleared and never launched, while an older intentional
  worktree-sleep record still resumes.

### Renderer integration tests

- Mounted tab close still destroys its xterm and terminates the PTY.
- Parked watcher disposal occurs before or with PTY shutdown and emits no final
  completion/bell notification.
- Closing one split pane preserves the sibling; closing the last pane retires
  the tab.
- Pane-to-tab detach preserves the PTY and resume record.
- Pinned-tab cancellation performs no shutdown; confirmed close does.
- Bulk close (`close others`, `close right`, kill-all) uses the same semantics.

### Provider/main tests

- Local, daemon, WSL, ConPTY, and SSH ownership route explicit close to the
  correct provider.
- Disconnected SSH close tombstones the app-scoped ID and never falls through to
  a local provider.
- Repeated `pty.kill` for the same ID is benign.
- Remote-runtime IDs cannot reach the local kill handler from renderer close.

### Electron end-to-end regression

1. Create a worktree terminal and start a deterministic long-lived child.
2. Switch worktrees and wait until the source worktree is cold-parked.
3. Close the parked tab.
4. Assert its exact PTY disappears from `pty:listSessions` and the child exits.
5. Restart/reload Orca and activate the worktree.
6. Assert no terminal or agent resume command is recreated for the closed pane.
7. Repeat with two split panes and with an SSH fixture where CI supports it.

### Soak and pressure gate

Run repeated create, park, close, reload, and reopen cycles. App-owned PTY count
must return to baseline after each cycle and remain bounded over the run. Record
the peak and final provider session count in CI artifacts.

## Observability

Emit a synchronous scheduled summary and an asynchronous completion summary:

- tab/worktree identifiers in hashed or existing diagnostic form;
- number of PTY IDs discovered by each source;
- provider classification counts;
- submitted count, then fulfilled/rejected counts after `Promise.allSettled`;
- number of resume records removed;
- whether the tab was parked or mounted when retired.

After the daemon-lease phase, Resource Manager should distinguish:

- attached sessions;
- warm-detached sessions eligible for reattach;
- ownerless/orphan sessions;
- pending/failed explicit retirement.

Alert locally before app-owned PTYs approach platform pressure. The warning is a
defense, not a substitute for lifecycle correctness.

## Rollout

1. Land the correctness patch without a feature flag. User close semantics are
   restorative behavior, not an experiment.
2. Keep hidden-view parking enabled; disabling it masks the ownership bug and
   forfeits its memory benefit.
3. Run focused unit/integration tests plus the live parked-close Electron gate.
4. Cut an RC and soak create/close/restart cycles while monitoring provider and
   OS PTY counts.
5. Ship daemon leases separately behind protocol compatibility and telemetry.

## Alternatives rejected

### Disable hidden-view parking

This restores the old accidental unmount behavior at significant memory cost
and leaves every other state-only close path fragile. It does not repair resume
records or daemon ownership.

### Kill only from `TerminalPane` cleanup

There is intentionally no pane during parking and some headless/runtime flows.
View cleanup cannot be process authority.

### Clear only resume records

This prevents resurrection but still leaks the live PTY until app/daemon exit.

### Kill only the tab row's `ptyId`

Split panes and partially reconciled layouts can own multiple IDs. The full
union is required.

### Rely only on a daemon idle timeout

Interactive agents can be legitimately idle for hours. Reaping by output
idleness loses user work; ownership, not activity, is the safe signal.

### Await every provider exit before hiding the tab

Remote and disconnected providers can take seconds or fail. UI retirement must
be immediate once the user confirms; provider completion is asynchronous and
observable.

## Phase 1 acceptance criteria

- A confirmed terminal-tab close submits retirement for every exclusively owned
  session Orca can currently reach and reports rejected requests without an
  unhandled promise.
- A closed agent session is never resumed by restart, activation, or mobile wake.
- Parking, move/detach, sleep/wake, and warm app reattach retain their documented
  behavior.
- Split, local, SSH, and remote-runtime ownership are covered by deterministic
  tests; Windows/WSL process-tree behavior remains a live-platform follow-up.
- PTY counts remain bounded across the soak scenario.
- No process-lifetime decision depends on React component mount state.

## Full-contract follow-ups

- Durable main-owned retirement intent and bounded retry inventory.
- Disconnected SSH relay kill-on-reconnect.
- Serializable daemon attachment leases with protocol-version fallback.
- Positive ownership validation for late hook events beyond the bounded recent-
  close registry.
