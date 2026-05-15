# SSH Remote Workspace Sync Plan

Planning note for refreshing PR #1690 against current `main`. This is not a merge plan for #1690; current `main` already owns same-client SSH PTY persistence through durable remote PTY leases, relay grace reconnect, explicit expired-session behavior, and provider cleanup semantics.

## Product Boundary

Orca should support an opt-in mode for an SSH target where terminal workspace chrome for that target is stored on the remote host and can be restored by another Orca client connecting to the same target.

In scope:

- Per-SSH-target remote workspace snapshots: terminal tabs, split layouts, active worktree/tab state, and remote PTY IDs needed to reattach live relay PTYs.
- Device presence for clients currently connected to the same synced target.
- Cross-client PTY reattach when the remote relay still owns the PTY.
- Conflict-safe snapshot writes with revisions and stale-write handling.
- Packaged app relay asset lookup and deployment reliability.

Out of scope:

- A general cloud sync service.
- Syncing local repos, local PTYs, local browser runtime state, credentials, secrets, shell history, or local filesystem paths.
- Guaranteed survival after the remote relay/host process exits.
- Automatic agent recovery as core PTY persistence.

Keep explicit/user-driven:

- Enabling sync per SSH target.
- Terminating remote sessions through an explicit destructive action. Normal disconnect detaches only.
- Resuming expired Claude/Codex agent sessions. Show an affordance using stored metadata; do not auto-inject resume commands into a shell.
- Resolving true conflicts that cannot be merged by target/worktree scope.

## Gap Analysis

Already covered on current `main`:

- Same-client SSH PTY survival across close/quit/reconnect through `activeConnectionIdsAtShutdown`, `remoteSessionIdsByTabId`, durable `SshRemotePtyLease` records, relay grace reconnect, and renderer deferred reattach.
- Explicit expired-session behavior: failed `pty.attach` marks leases expired and the renderer starts from the expired state rather than silently pretending the old process survived.
- Provider absence and relay teardown semantics: disconnect detaches, terminate/remove is destructive, and provider registration/ownership are centralized in `SshRelaySession`/`pty.ts`.
- Relay-side PTY buffering, attach, shutdown, and grace timers.

#1690 adds beyond that:

- Relay-side `workspace.*` RPCs and JSON snapshot storage on the remote host.
- A target-scoped session filter and scoped merge so one target's snapshot does not overwrite unrelated local/remote workspaces.
- Remote workspace IPC (`remoteWorkspace:*`) and preload API.
- Renderer hydration of remote snapshots and event-driven application of `workspace.changed`.
- Device presence polling and status UI.
- Multi-client relay dispatcher/socket support so more than one Orca client can talk to the same relay daemon.
- Resize ownership logic so background clients do not resize a shared remote PTY.
- Packaged relay asset lookup through `process.resourcesPath`/`extraResources`.
- Agent resume metadata tied to pane keys. This remains deferred for this implementation.

Now redundant or risky from #1690:

- Do not copy the renderer terminal restore changes wholesale. They overlap directly with recently stabilized `reconnectPersistedTerminals`, deferred SSH session IDs, split-leaf PTY mappings, and expired-session handling.
- Do not replace same-client persistence with relay snapshots. Local workspace session remains the source of truth for classic SSH targets and for non-synced targets.
- Do not default sync to on for existing or new targets until product decides retention/privacy behavior.
- Do not use unlimited relay lifetime as an implicit consequence of sync without a visible setting and cleanup story.
- Do not auto-run agent resume commands after an expired PTY.

## Fresh Architecture

Use two separate layers:

1. **Local session persistence remains authoritative for this Orca install.** It continues to write normal workspace sessions and durable SSH PTY leases exactly as current `main` does.
2. **Remote workspace sync is an opt-in target-level overlay.** When enabled and connected, Orca pushes only that target's scoped workspace slice to the relay and hydrates only that target's slice from the relay.

Data ownership:

- Main process owns target configuration, active SSH sessions, remote workspace IPC, snapshot revision checks, ID translation, and old-relay compatibility handling.
- Relay owns synced snapshot storage under a per-user remote directory, keyed by a sanitized namespace derived from stable target identity.
- Renderer owns local Zustand workspace state and applies remote snapshots only through a guarded hydration path.
- PTY lifetime remains owned by the relay and current `SshRemotePtyLease`/PTY ownership maps. Remote snapshots store PTY IDs as references, not as process ownership.

Remote snapshot shape:

- `namespace`, `revision`, `updatedAt`, `schemaVersion`, `clientId`, and `session`.
- `session` is an explicit v1 projection, not raw `WorkspaceSessionState`.
- v1 includes only terminal/worktree state, keyed by stable remote worktree path. Import/export translates between remote worktree paths and local `repoId::path` IDs at the main/renderer boundary.
- Editor/browser chrome, browser URL history, browser profile IDs, and global active connection IDs are excluded from v1 to avoid syncing local-install identifiers or privacy-sensitive local state.
- Additive fields are okay; wrong-typed core fields must fall back safely.

Sync flow:

- On connect for sync-enabled target: register providers, fetch worktrees, fetch `workspace.get`, translate remote path IDs to local worktree IDs, scope-merge into local state, then let existing terminal reattach paths consume the resulting PTY IDs.
- Local state remains authoritative immediately after startup. A remote snapshot is applied only if this target has no local dirty state newer than the last synced revision, or the user explicitly refreshes from remote.
- On local session write: if workspace session is ready and the target was hydrated, export only that target's terminal/worktree slice using remote worktree paths and `workspace.patch` with the last known revision.
- On stale revision: if both local and newer remote touched the same worktree since the base revision, set conflict state. Otherwise preserve out-of-scope/untouched remote state, merge local touched worktrees, and retry once.
- On relay `workspace.changed`: ignore self-originated events, queue per target, apply only newer revisions, and avoid triggering a resize unless there is trusted local foreground intent.

Failure semantics:

- Old relay without `workspace.*`: keep classic SSH behavior, mark sync "unavailable until reconnect/update", and do not fail SSH connection.
- Remote snapshot parse failure: ignore the remote snapshot, leave local session intact, and show sync error for that target.
- Patch failure: keep local session as-is and retry on next session write or reconnect.
- Expired PTY referenced by remote snapshot: use the current expired-session path; do not silently replace with a live shell unless the existing UI path already does that intentionally.
- Explicit disconnect keeps remote PTYs according to current detach semantics. `Terminate remote sessions` kills PTYs. Target removal is destructive after confirmation and must clear or tombstone that target's synced PTY references.

## Phased Implementation Plan

1. **Relay packaging and compatibility PR**
   - Add relay `extraResources` packaging and `getLocalRelayCandidates(platform)` lookup using `process.resourcesPath`.
   - Keep current dev path and `ORCA_RELAY_PATH`.
   - Add tests for packaged candidate order and missing package diagnostics.

2. **Target setting and main IPC skeleton PR**
   - Add `remoteWorkspaceSyncEnabled` and bounded `remoteWorkspaceSyncGracePeriodSeconds` to `SshTarget`.
   - Default to false unless product explicitly chooses otherwise.
   - Add preload/main `remoteWorkspace:*` IPC behind feature availability.
   - No renderer hydration yet; verify old targets normalize cleanly.

3. **Relay workspace snapshot RPC PR**
   - Add relay `workspace.get`, `workspace.patch`, and `workspace.presence`.
   - Store snapshots atomically under a user-private remote directory.
   - Include namespace sanitization, revisions, schema version, and stale-revision responses.
   - Wire old-relay method-not-found handling in main as "sync unavailable", not connection failure.

4. **Projected session filtering/merge PR**
   - Implement target-scoped session extraction in main using repo `connectionId`.
   - Export/import terminal workspace state through a path-keyed projected schema.
   - Implement merge that replaces only known in-scope worktrees and preserves out-of-scope remote state.
   - Cover terminal tabs, split layouts, active IDs, `remoteSessionIdsByTabId`, and last-visited timestamps. Defer editor/browser chrome.

5. **Renderer guarded hydrate/push PR**
   - Fetch synced snapshots only after target worktrees are loaded.
   - Apply snapshots through a remote-hydration guard and per-target queue.
   - Push snapshots from the existing debounced session writer only for hydrated, connected, sync-enabled targets.
   - Reuse existing `reconnectPersistedTerminals`; only feed it scoped remote session IDs.
   - Do not enable live cross-client PTY attach unless the multi-client dispatcher and resize ownership from phase 6 are also present.

6. **Multi-client relay + resize ownership PR**
   - Extend relay dispatcher/socket bridge to support independent client frame state.
   - Broadcast notifications to all clients, but keep request/response routing per client.
   - Add foreground/local-intent resize ownership so background hydration or non-focused clients do not resize shared PTYs.
   - Treat mobile fit locks and current PTY locks as higher priority than desktop resize.

7. **Presence and status UI PR**
   - Add lightweight presence polling and status display for sync-enabled connected targets.
   - Show sync phase: idle, pulling, pushing, synced, conflict, error, unavailable/offline.
   - Follow `docs/STYLEGUIDE.md` tokens and existing status bar patterns.

8. **Agent resume metadata polish PR**
   - Persist provider/session/cwd metadata as recovery hints only.
   - Add an explicit "Resume Claude/Codex session" action when a synced PTY expired.
   - Avoid auto-sending commands on mount or after snapshot hydration.

## Test Plan

Unit:

- Target normalization preserves existing targets and defaults sync off.
- Namespace derivation is stable and sanitization rejects path traversal/control chars.
- Relay snapshot read/write handles missing, corrupt, stale, and atomic-write cases.
- Target-scoped filter excludes local repos and other SSH targets.
- Projected snapshot import/export translates stable remote worktree paths to local `repoId::path` IDs.
- Scoped merge preserves out-of-scope remote worktrees and deletes in-scope records when the remote snapshot says they are gone.
- Stale revision retry preserves edits from the newer remote snapshot.
- Old relay `-32601` maps to sync unavailable.
- Packaged relay candidate lookup searches `process.resourcesPath` and dev paths.
- Resize ownership gates remote resize on focused/local user intent.

Integration:

- Current same-client persistence still passes: close/quit/reconnect restores SSH PTYs without remote workspace sync enabled.
- Sync-enabled target push writes only that target's session slice.
- Cross-device simulation with two mux clients: client A pushes, client B receives `workspace.changed`, hydrates, and attaches the same relay PTY.
- Two clients patch concurrently: one stale response, one retry, no out-of-scope data loss.
- Explicit disconnect detaches but preserves leases; terminate sessions kills remote PTYs and marks leases terminated.
- Relay restart or expired grace marks PTY references expired and does not auto-resume agents.
- Provider-registration wait, if still needed, waits only for restored SSH reattach and does not mask normal spawn failures.

E2E/manual:

- Packaged macOS/Linux/Windows app can deploy the relay from packaged resources.
- Old running relay continues classic SSH behavior and shows sync unavailable until reconnected with a new relay.
- Two Orca clients on different machines connect to the same target, open a shared remote workspace, and verify tab/layout sync.
- Resize a focused terminal on one client while another client is backgrounded; full-screen TUI dimensions follow only the focused client.
- Mobile/desktop mixed client does not fight PTY dimensions when mobile fit lock is active.
- Passphrase-protected targets defer reconnect without losing remote session IDs.

## Risks And Decisions

Decisions before implementation:

- Default: should remote workspace sync be opt-in off for all targets? Recommendation: yes.
- Retention: is `0` unlimited relay lifetime acceptable, or should sync use a large bounded default with visible cleanup?
- Namespace identity: include `configHost`, host, port, and username. Label changes do not affect namespace.
- Snapshot scope: v1 is terminal + layout + active worktree/tab only. Editor/browser comes later with explicit allowlists and translation rules.
- Conflict UX: retry once automatically, then surface "Refresh from remote" / "Overwrite remote" choices.
- Agent resume UX: explicit action location in expired terminal state or status toast.

Main risks:

- Cross-device resize fights can corrupt TUI layout; ship ownership gates with the first cross-client PTY attach.
- Snapshot merge bugs can delete unrelated local or remote workspace state; keep target filtering/merge isolated and heavily tested.
- Unlimited remote relay lifetime can leave processes running unexpectedly; make retention visible and terminate explicit.
- Old relays may live across app updates; every new RPC must fail open.
- Renderer hydration can trigger existing session writers and feedback loops; use hydration guards and per-target revision tracking.
- Remote snapshots contain path/workspace metadata on the SSH host; treat as local-to-remote-user data and document the storage path.
