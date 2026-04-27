# Design: Persist and Auto-Restore SSH Sessions Across App Restarts

**Issue:** [#985](https://github.com/stablyai/orca/issues/985)
**Branch:** `Jinwoo-H/persist-ssh-985`
**Author:** Jinwoo Hong
**Status:** Draft

## Problem

When Orca quits (intentionally, via update, or crash), all SSH connections and remote terminal sessions are lost. On restart, users must manually re-open each remote worktree, wait for SSH + relay redeploy, and re-start every remote process — even though the relay daemon on the remote host stays alive during its 5-minute grace window.

Three specific gaps:

1. **SSH connections are not persisted.** `buildWorkspaceSessionPayload()` in `src/renderer/src/lib/workspace-session.ts` captures terminal tabs, layouts, editor files, and browser tabs but has zero SSH state. `WorkspaceSessionState` has no fields for active connection IDs.

2. **Remote PTY session IDs are not persisted.** `reconnectPersistedTerminals()` in `src/renderer/src/store/slices/terminals.ts:1205` explicitly skips SSH-backed repos (`const supportsDeferredReattach = !repo?.connectionId`). Even if the relay keeps PTYs alive, Orca doesn't know their session IDs after restart.

3. **Shutdown doesn't serialize SSH state.** Neither `beforeunload` in `App.tsx` nor `will-quit` in `src/main/index.ts` records which SSH targets were connected or what remote PTY session IDs existed.

## Scope

**In scope (Layer 1 — app-bound lifetime):**
- Persist active SSH connection targets and remote PTY session IDs at shutdown
- Auto-reconnect SSH targets on startup
- Reattach remote PTYs via the relay's existing `pty.attach` RPC
- Make the relay grace window configurable via settings

**Out of scope (Layer 2 — future):**
- Background daemon owning SSH connections independent of app lifecycle
- Credential persistence (passphrases/passwords remain session-only)

## Existing Architecture

### What already works

| Component | File | Behavior |
|-----------|------|----------|
| Relay grace timer | `src/relay/relay.ts:15,70-76` | Keeps PTYs alive 5 min after client disconnect |
| Relay `pty.attach` | `src/relay/pty-handler.ts` | Replays buffered output on reattach |
| In-session reconnect | `src/main/ipc/ssh-relay-helpers.ts` | `reestablishRelayStack()` re-deploys relay, reattaches PTYs for transient drops |
| SSH target persistence | `src/main/persistence.ts:365-398` | Target configs (host, user, identity) survive restarts |
| Local PTY reattach | `src/renderer/src/store/slices/terminals.ts:1167-1266` | Daemon-mode local PTYs reattach via `pendingReconnectPtyIdByTabId` |
| PTY ownership tracking | `src/main/ipc/pty.ts` | `getPtyIdsForConnection()` maps PTY IDs to connection targets (in-memory) |
| SSH connection retry | `src/main/ssh/ssh-connection.ts` | Exponential backoff reconnection for transient errors |

### Connection lifecycle (current)

```
App Start → hydrate repos/worktrees → reconnectPersistedTerminals()
                                        ↓
                              skips SSH repos (connectionId truthy)
                                        ↓
                              SSH tabs show as disconnected
```

```
App Shutdown → beforeunload → buildWorkspaceSessionPayload()
                                ↓
                     captures local PTY IDs, tabs, layouts
                     does NOT capture SSH connection state
                     does NOT capture remote PTY session IDs
```

## Design

### 1. Extend WorkspaceSessionState

**File:** `src/shared/types.ts`

Add two new optional fields:

```typescript
export type WorkspaceSessionState = {
  // ... existing fields ...

  /** SSH target IDs that were connected at shutdown. Used on startup to
   *  auto-reconnect before attempting remote PTY reattach. */
  activeConnectionIdsAtShutdown?: string[]

  /** Maps tab IDs to their remote relay PTY session IDs. Mirrors
   *  pendingReconnectPtyIdByTabId but for SSH-backed terminals. Populated
   *  at shutdown from the main-process PTY ownership registry. */
  remoteSessionIdsByTabId?: Record<string, string>
}
```

**File:** `src/shared/workspace-session-schema.ts`

Add corresponding Zod schemas:

```typescript
activeConnectionIdsAtShutdown: z.array(z.string()).optional(),
remoteSessionIdsByTabId: z.record(z.string(), z.string()).optional(),
```

### 2. Capture SSH state at shutdown

**File:** `src/renderer/src/lib/workspace-session.ts`

The `WorkspaceSessionSnapshot` type gains two new fields from AppState, and `buildWorkspaceSessionPayload()` populates the new session fields.

The renderer already has the data it needs — no IPC required. `tabsByWorktree` contains each tab's `ptyId`, and the renderer knows which worktrees are SSH-backed via `repo.connectionId`. Building the map renderer-side avoids a synchronous IPC call during `beforeunload` (which is fragile: sync IPC blocks the main process and can be dropped under time pressure on quit).

**File:** `src/renderer/src/lib/workspace-session.ts`

Add `sshConnectionStates` and `repos` / `worktreesByRepo` to the `WorkspaceSessionSnapshot` Pick type, then build both new fields in `buildWorkspaceSessionPayload()`:

```typescript
// Capture active SSH connections.
// Why: sshConnectionStates is a Map<string, SshConnectionState>, not a plain
// object. Object.entries() on a Map returns [] — must use Array.from().
const connectedTargetIds = Array.from(snapshot.sshConnectionStates.entries())
  .filter(([, state]) => state.status === 'connected')
  .map(([targetId]) => targetId)

// Build remote PTY session IDs from renderer state.
// Why: the renderer already has tab.ptyId for every terminal tab and knows
// which worktrees are SSH-backed via repo.connectionId. Deriving the map
// here avoids a sync IPC round-trip during beforeunload, which is fragile
// (can be dropped by Chromium under shutdown time pressure).
const remoteSessionIdsByTabId: Record<string, string> = {}
for (const [worktreeId, tabs] of Object.entries(snapshot.tabsByWorktree)) {
  const worktree = Object.values(snapshot.worktreesByRepo)
    .flat()
    .find((w) => w.id === worktreeId)
  const repo = worktree
    ? snapshot.repos.find((r) => r.id === worktree.repoId)
    : null
  if (!repo?.connectionId) continue  // not SSH-backed
  for (const tab of tabs) {
    if (tab.ptyId) {
      remoteSessionIdsByTabId[tab.id] = tab.ptyId
    }
  }
}

return {
  // ... existing fields ...
  activeConnectionIdsAtShutdown: connectedTargetIds.length > 0
    ? connectedTargetIds : undefined,
  remoteSessionIdsByTabId: Object.keys(remoteSessionIdsByTabId).length > 0
    ? remoteSessionIdsByTabId : undefined,
}
```

### 3. Auto-reconnect SSH on startup

**File:** `src/renderer/src/App.tsx`

Insert an SSH reconnect pass between workspace hydration and `reconnectPersistedTerminals()`. Targets are split into two categories:

1. **Non-passphrase targets** — reconnected eagerly at startup in parallel.
2. **Passphrase-protected targets** — deferred until the user focuses an SSH-backed terminal tab.

**Why defer passphrase targets:** Eagerly reconnecting passphrase-protected keys would pop credential dialogs before the user has context about which terminal is reconnecting. Stacking multiple passphrase prompts at startup is disorienting and error-prone (wrong passphrase entered for the wrong key). Deferring to tab focus lets the user see the terminal they're about to reconnect and provide the credential with full context.

```typescript
// After repos/worktrees hydrated, before terminal reconnect
const connectionIds = session.activeConnectionIdsAtShutdown ?? []
const SSH_RECONNECT_TIMEOUT_MS = 15_000

if (connectionIds.length > 0) {
  // Partition targets: eagerly reconnect non-passphrase targets,
  // defer passphrase-protected targets to tab focus.
  // Why: use listTargets (which already has an IPC handler) and index
  // by ID, rather than adding a per-target IPC call. Fetching all
  // targets in one call is simpler and avoids adding a new ssh:getTarget
  // handler that would only be used here.
  const allTargets = await window.api.ssh.listTargets()
  const targetMap = new Map(allTargets.map((t) => [t.id, t]))
  const targets = connectionIds.map((targetId) => {
    const target = targetMap.get(targetId)
    return { targetId, needsPassphrase: target?.lastRequiredPassphrase ?? false }
  })

  const eagerTargets = targets.filter((t) => !t.needsPassphrase)
  const deferredTargets = targets.filter((t) => t.needsPassphrase)

  // Store deferred targets so on-demand reconnect can pick them up
  if (deferredTargets.length > 0) {
    actions.setDeferredSshReconnectTargets(
      deferredTargets.map((t) => t.targetId)
    )
  }

  // Reconnect eager targets in parallel with per-target timeout.
  // Why: a per-target timeout prevents a single unreachable host from
  // blocking the entire startup sequence. 15 seconds is long enough for
  // a typical SSH handshake + relay redeploy over broadband, short enough
  // to avoid the user staring at a frozen app.
  await Promise.allSettled(
    eagerTargets.map(({ targetId }) =>
      Promise.race([
        window.api.ssh.connect({ targetId }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('SSH reconnect timeout')),
            SSH_RECONNECT_TIMEOUT_MS)
        )
      ]).catch((err) => {
        console.warn(`SSH auto-reconnect failed for ${targetId}:`, err)
      })
    )
  )
}

// Now proceed with terminal reconnect (which can now include SSH tabs)
await actions.reconnectPersistedTerminals(abortController.signal)
```

**On-demand reconnect for deferred (passphrase-protected) targets:**

When the user focuses a terminal tab backed by a deferred SSH target, the tab's mount logic checks `deferredSshReconnectTargets`. If the tab's `connectionId` is in that set, it triggers `ssh:connect` for that target, shows the passphrase dialog naturally, and on success proceeds with `pty.attach` for that tab's persisted session ID. The target is removed from the deferred set once connected (or after the user cancels).

```typescript
// In terminal pane mount / tab focus handler
const deferredTargets = get().deferredSshReconnectTargets ?? []
if (repo?.connectionId && deferredTargets.includes(repo.connectionId)) {
  // Show reconnecting overlay on this tab (see Section 6)
  try {
    await window.api.ssh.connect({ targetId: repo.connectionId })
    actions.removeDeferredSshReconnectTarget(repo.connectionId)
    // Proceed to pty.attach with the persisted sessionId
  } catch (err) {
    // Leave tab in disconnected state with retry affordance
  }
}
```

The `ssh:connect` IPC handler already exists and handles the full flow: SSH connect → relay deploy → provider registration. No new main-process code needed for the connect path.

**Error handling:** Each connection attempt is independent. Failed connections show the existing `SshDisconnectedDialog` with manual retry. Successful connections proceed to PTY reattach.

**Credential prompts:** For eager (non-passphrase) targets, the reconnect completes without user interaction. For deferred targets, the existing `SshPassphraseDialog` flow fires at tab focus — `ssh:credential-request` IPC is already wired.

### 4. Enable remote PTY reattach

**File:** `src/renderer/src/store/slices/terminals.ts`

The current gate at line 1205:

```typescript
const supportsDeferredReattach = !repo?.connectionId
```

Changes to:

```typescript
const supportsDeferredReattach = !repo?.connectionId || hasActiveConnection(repo.connectionId)
```

Where `hasActiveConnection` checks the renderer's `sshConnectionStates` store for `status === 'connected'`.

For SSH-backed tabs, the reattach data comes from the new `remoteSessionIdsByTabId` session field instead of `pendingReconnectPtyIdByTabId` (which is populated from the local daemon). The hydration step in `hydrateWorkspaceSession` needs to merge remote session IDs into `pendingReconnectPtyIdByTabId`.

**Critical placement constraint:** The existing `pendingReconnectPtyIdByTabId` population loop (lines 1090-1108) is guarded by `if (daemonEnabled)` and explicitly skips SSH-backed repos (`if (repo?.connectionId) { continue }`). The remote session ID merge must run **outside and after** that guard block — SSH PTY reattach does not depend on the local terminal daemon; it uses the relay's `pty.attach` RPC. If the merge is placed inside the `daemonEnabled` block, users without the experimental daemon flag will never have remote session IDs populated, silently breaking the entire reattach feature.

**File:** `src/renderer/src/store/slices/terminals.ts` — In `hydrateWorkspaceSession`, after the existing `if (daemonEnabled) { ... }` block (line 1108):

```typescript
// Existing code (unchanged):
const daemonEnabled = s.settings?.experimentalTerminalDaemon === true
const pendingReconnectPtyIdByTabId: Record<string, string> = {}
if (daemonEnabled) {
  // ... existing loop for local daemon session IDs (skips SSH repos) ...
}

// NEW: merge remote PTY session IDs from SSH persistence.
// Why: this runs outside the daemonEnabled guard because remote PTY reattach
// uses the relay's pty.attach RPC, not the local terminal daemon. SSH-backed
// tabs need their session IDs regardless of the experimentalTerminalDaemon
// setting. The existing loop above correctly skips SSH repos (connectionId
// check), so there is no overlap — local daemon IDs and remote session IDs
// are mutually exclusive per-tab.
const remoteSessionIds = session.remoteSessionIdsByTabId ?? {}
for (const [tabId, sessionId] of Object.entries(remoteSessionIds)) {
  if (validTabIds.has(tabId)) {
    pendingReconnectPtyIdByTabId[tabId] = sessionId
  }
}
```

The inner guard in `reconnectPersistedTerminals` (`if (supportsDeferredReattach && tabLevelPtyId)`) works correctly for SSH tabs because `tabLevelPtyId` is now populated by this merge, and `supportsDeferredReattach` is `true` for connected SSH targets.

**File:** `src/main/providers/ssh-pty-provider.ts` — Modify `spawn()` to detect sessionId:

The current `SshPtyProvider.spawn()` unconditionally calls `pty.spawn` and ignores `opts.sessionId`. This is the critical missing link — without this change, passing a sessionId through `connectPanePty` has no effect on the remote relay.

```typescript
async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
  // Why: when sessionId is present, the caller is requesting reattach to an
  // existing relay PTY (persisted across app restart). Calling pty.spawn would
  // create a new shell and discard the buffered output the relay kept alive
  // during the grace window. pty.attach replays that buffer instead.
  if (opts.sessionId) {
    try {
      await this.mux.request('pty.attach', {
        id: opts.sessionId,
        cols: opts.cols,
        rows: opts.rows
      })
      return { id: opts.sessionId }
    } catch (err) {
      // Why: pty.attach fails when the relay grace window has elapsed and the
      // PTY no longer exists (relay returns "not found"). Without this catch,
      // the error propagates as an unhandled rejection and the terminal tab
      // stays stuck. Falling through to pty.spawn gives the user a fresh
      // shell, and sessionExpired lets the renderer show a brief toast
      // ("Session expired — new shell started") so the user understands why
      // their scrollback is gone.
      console.warn(`[ssh-pty] pty.attach failed for ${opts.sessionId}, falling back to fresh spawn:`, err)
    }
  }

  const result = await this.mux.request('pty.spawn', {
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: opts.env
  })
  // Why: sessionExpired is only set when we attempted reattach and it failed.
  // The renderer checks this flag to show the "Session expired" toast. When
  // sessionId was never provided (fresh terminal), this field is omitted.
  return {
    ...(result as PtySpawnResult),
    ...(opts.sessionId ? { sessionExpired: true } : {})
  }
}
```

The `PtySpawnResult` type (in `src/main/providers/types.ts`) needs a new optional field:

```typescript
export type PtySpawnResult = {
  id: string
  /** True when the caller requested reattach (sessionId was provided) but the
   *  relay PTY was gone (grace window elapsed). The renderer uses this to show
   *  a brief "Session expired — new shell started" toast. */
  sessionExpired?: boolean
}
```

This routes through to the relay's existing `pty.attach` RPC, which replays buffered output via the `pty.replay` notification.

**File:** `src/main/ipc/ssh-relay-helpers.ts` — Wire `onReplay` in `wireUpSshPtyEvents()`:

The current `wireUpSshPtyEvents()` only wires `onData` and `onExit`. It does **not** wire `onReplay`. After `pty.attach`, the relay sends a `pty.replay` notification with buffered output, but without this wiring the replay data is silently dropped and the terminal renders blank after reattach.

Why use a dedicated `pty:replay` IPC channel (not `pty:data`): the renderer's `pty-transport.ts` has a `replayingBufferedData` flag that suppresses xterm auto-replies to embedded terminal query sequences (e.g., `\x1b[6n` for cursor position reports) during replay. If relay replay data arrives via the regular `pty:data` channel, this flag is **not set** — xterm processes the data as normal output and auto-replies leak into the remote shell as stray input, potentially executing unintended commands. A dedicated `pty:replay` channel lets the renderer route replay through the guarded `onReplayData` callback, which suppresses auto-replies.

```typescript
export function wireUpSshPtyEvents(
  ptyProvider: SshPtyProvider,
  getMainWindow: () => BrowserWindow | null
): void {
  ptyProvider.onData((payload) => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('pty:data', payload)
    }
  })
  // Why: after pty.attach, the relay sends pty.replay with buffered output
  // from the grace window. Without this, reattached terminals render blank.
  // Uses a dedicated pty:replay channel (not pty:data) so the renderer can
  // route it through the replay-guarded onReplayData callback, which
  // suppresses xterm auto-replies to embedded query sequences.
  ptyProvider.onReplay((payload) => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('pty:replay', payload)
    }
  })
  ptyProvider.onExit((payload) => {
    clearProviderPtyState(payload.id)
    deletePtyOwnership(payload.id)
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('pty:exit', payload)
    }
  })
}
```

The renderer needs a corresponding `pty:replay` handler in `pty-dispatcher.ts` that routes through the existing `onReplayData` callback (same path used by the local daemon's eager buffer replay). This ensures `replayingBufferedData` is set and xterm auto-replies are suppressed during relay replay.

The preload bridge (`src/preload/index.ts`) needs a new `onReplay` binding alongside the existing `onData`:

```typescript
pty: {
  // ... existing bindings ...
  onReplay: (callback: (payload: PtyDataPayload) => void) =>
    ipcRenderer.on('pty:replay', (_event, payload) => callback(payload)),
}
```

Then in `reconnectPersistedTerminals`, when the SSH connection is confirmed active, the existing `pty.spawn` call in `connectPanePty` receives the `sessionId` which routes through `SshPtyProvider.spawn()` → relay `pty.attach()`, replaying buffered output.

**Wait for SSH before reattach:** The key ordering constraint is that `reconnectPersistedTerminals` must run *after* SSH connections are established. The sequential await in App.tsx (step 3) guarantees this.

### 5. Configurable relay grace window

**File:** `src/shared/ssh-types.ts` — Extend `SshTarget`:

```typescript
export type SshTarget = {
  // ... existing fields ...

  /** Grace period in seconds before relay shuts down after disconnect.
   *  Default: 300 (5 minutes). */
  relayGracePeriodSeconds?: number

  /** Set to true after a successful connection that triggered a credential
   *  prompt (passphrase or password), false after one that didn't. Persisted
   *  with the target config so the startup reconnect logic can partition
   *  targets into eager (no passphrase) vs deferred (passphrase) without
   *  attempting a connection first.
   *
   *  Why a persisted flag instead of inspecting the key at startup: detecting
   *  whether a key is encrypted requires attempting to load it, which is
   *  expensive and may itself trigger an OS keychain prompt. Recording the
   *  outcome of the last successful connection is both cheaper and more
   *  accurate (it reflects the user's actual auth experience). */
  lastRequiredPassphrase?: boolean
}
```

**Population:** The `lastRequiredPassphrase` flag is set during `ssh:connect` success handling in the main process. When `SshConnection.connect()` succeeds, the handler checks whether a credential prompt was issued during the attempt (the `onCredentialRequest` callback was invoked). If yes, the flag is set to `true` on the target and persisted; if no, it is set to `false`. This ensures the flag stays up to date as users add/remove passphrases from their keys.

**File:** `src/main/ssh/ssh-relay-deploy.ts` — Pass grace time to relay launch:

```typescript
const graceSeconds = target.relayGracePeriodSeconds ?? 300
const command = `${relayPath} --grace-time ${graceSeconds}`
```

**File:** `src/renderer/src/components/settings/SshTargetForm.tsx` — Add UI field with reasonable bounds (60s–3600s).

The relay already accepts `--grace-time` CLI arg (`src/relay/relay.ts:17-29`).

## Sequence Diagram

### Shutdown

```
Renderer                        Main Process
   │                                │
   ├─ beforeunload fires            │
   ├─ capture terminal buffers      │
   ├─ build session payload         │
   │  (derives remoteSessionIdsByTabId from
   │   Zustand state: tabsByWorktree + repo.connectionId;
   │   derives activeConnectionIdsAtShutdown from
   │   sshConnectionStates — no IPC needed)
   ├─ session:set-sync ────────────►├─ write to orca-data.json
   │                                ├─ flush()
   └─ window closes                 └─ SSH connections drop
                                       relay grace timer starts
```

### Startup (eager targets — no passphrase)

```
Renderer                        Main Process              Remote Relay
   │                                │                         │
   ├─ session:get ─────────────────►├─ read orca-data.json    │
   │◄─ session ────────────────────┤                          │
   ├─ hydrate repos, tabs, layouts  │                         │
   ├─ partition targets:            │                         │
   │   eager vs deferred            │                         │
   │                                │                         │
   ├─ ssh:connect(eager1) ─────────►├─ SSH handshake ────────►│
   │  (15s timeout per target)      ├─ deploy relay ─────────►├─ READY
   │                                ├─ register roots         │
   │◄─ connected ──────────────────┤                          │
   │                                │                         │
   ├─ reconnectPersistedTerminals() │                         │
   │  (SSH tabs no longer skipped   │                         │
   │   for connected targets)       │                         │
   │                                │                         │
   ├─ connectPanePty(sessionId) ───►├─ SshPtyProvider.spawn() │
   │                                │  detects sessionId      │
   │                                ├─ pty.attach(id) ──────►├─ replay buffer
   │◄─ pty.replay ─────────────────┤◄─ pty.replay ──────────┤
   │  terminal shows restored       │                         │
   │  scrollback + live shell       │                         │
```

### Startup (deferred targets — passphrase-protected)

```
Renderer                        Main Process              Remote Relay
   │                                │                         │
   │  (passphrase targets stored    │                         │
   │   in deferredSshReconnectTargets)                        │
   │                                │                         │
   ├─ user focuses SSH tab ─────────│                         │
   │  tab shows "Reconnecting..."   │                         │
   │  overlay                       │                         │
   ├─ ssh:connect(deferred1) ──────►├─ SSH handshake          │
   │                                ├─ ssh:credential-request │
   │◄─ passphrase dialog ──────────┤                          │
   ├─ user enters passphrase ──────►├─ auth continues ───────►│
   │                                ├─ deploy relay ─────────►├─ READY
   │◄─ connected ──────────────────┤                          │
   │                                │                         │
   ├─ connectPanePty(sessionId) ───►├─ pty.attach(id) ──────►├─ replay buffer
   │◄─ pty.replay ─────────────────┤◄─ pty.replay ──────────┤
   │  overlay removed, terminal     │                         │
   │  shows restored scrollback     │                         │
```

## Per-Tab Reconnect Status

During SSH reconnection and PTY reattach, individual terminal tabs need visual feedback so the user knows what's happening and which tabs are still in progress.

**Reconnecting state:** While an SSH target is being reconnected (either eagerly at startup or on-demand at tab focus), each affected terminal tab shows a semi-transparent overlay with a spinner and the text "Reconnecting to [host]...". The terminal content beneath is dimmed but visible — the user can see their previous scrollback through the overlay.

**Reattaching state:** After SSH connects but before `pty.attach` completes and replays the buffer, the overlay updates to "Reattaching session...". This is typically brief (<1 second) but visible on high-latency connections.

**Success:** The overlay is removed and the terminal receives the replayed buffer. No toast or notification — the terminal being live is sufficient signal.

**Failure — target failed:** If the SSH connection fails (timeout, network error, cancelled passphrase), the overlay is replaced with a persistent banner: "SSH connection failed — [reason]" with a "Retry" button. The terminal content remains visible but dimmed and non-interactive.

**Failure — session expired:** If SSH connects but `pty.attach` returns `not-found` (grace window elapsed), the tab shows a brief inline message "Session expired — new shell started" and spawns a fresh PTY. The message auto-dismisses after 5 seconds.

## Partial Failure Behavior

When multiple SSH targets are reconnected at startup, some may succeed and others may fail. The user needs clear per-tab attribution of which connections failed:

- **Tabs backed by a successful target:** Proceed to PTY reattach normally. No special indicator — they work as expected.
- **Tabs backed by a failed target:** Show the persistent failure banner described above. The banner includes the target hostname so the user can identify which remote host is unreachable.
- **Tabs backed by a deferred (passphrase) target:** Show a static overlay: "Waiting for connection — focus this tab to reconnect". This distinguishes intentionally-deferred tabs from failed tabs.

This ensures the user can scan their tab bar and immediately tell which terminals are live, which need attention, and which are waiting for credentials.

## Data Flow Diagrams

### Path 1: Happy path (restart within grace window)

```
SHUTDOWN:
  Zustand state ──► buildWorkspaceSessionPayload() ──► orca-data.json
  (tabsByWorktree,    (derives remoteSessionIdsByTabId,    (persisted)
   sshConnectionStates, activeConnectionIdsAtShutdown)
   repos, worktreesByRepo)

STARTUP:
  orca-data.json ──► hydrateWorkspaceSession() ──► ssh:connect(eager) ──► reconnectPersistedTerminals()
  (read)              (merges remoteSessionIds       (SSH + relay up)       (pty.attach via SshPtyProvider)
                       into pendingReconnectPtyIdByTabId)                     ──► pty.replay ──► terminal live
```

### Path 2: Nil path (no SSH state persisted)

```
SHUTDOWN:
  No SSH connections active ──► buildWorkspaceSessionPayload() ──► orca-data.json
                                 (activeConnectionIdsAtShutdown     (no SSH fields)
                                  omitted, remoteSessionIdsByTabId
                                  omitted)

STARTUP:
  orca-data.json ──► hydrateWorkspaceSession() ──► reconnectPersistedTerminals()
  (no SSH fields)     (no remote IDs to merge)      (SSH tabs still skipped — connectionId
                                                      but no active connection)
```

### Path 3: Grace expired (restart after relay grace window)

```
SHUTDOWN:
  (same as happy path — SSH state persisted to orca-data.json)

STARTUP:
  orca-data.json ──► ssh:connect() ──► relay redeploy ──► pty.attach(sessionId)
                     (SSH succeeds)     (new relay instance;    ──► NOT FOUND
                                         old PTYs gone)             ──► spawn fresh PTY
                                                                    ──► "Session expired" message
```

### Path 4: Error path (SSH connect fails)

```
SHUTDOWN:
  (same as happy path — SSH state persisted to orca-data.json)

STARTUP:
  orca-data.json ──► ssh:connect() ──► TIMEOUT/ERROR (15s)
                                         ──► tab shows failure banner
                                         ──► reconnectPersistedTerminals()
                                              skips tabs for failed targets
                                              (no active connection)
                                         ──► user retries manually via banner
```

## Migration & Backwards Compatibility

- New session fields are optional (`z.optional()`), so older sessions parse without error
- Older Orca versions ignore unknown fields, so a downgrade doesn't break
- If `activeConnectionIdsAtShutdown` references a deleted SSH target, the connect call fails gracefully and the tab shows as disconnected
- If `remoteSessionIdsByTabId` references a PTY that expired (grace window elapsed), `pty.attach` returns `not-found` and the tab spawns a fresh shell

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Relay grace expired before restart | `pty.attach` fails → tab spawns fresh PTY, shows "Session expired — new shell started" |
| SSH target deleted between shutdown and startup | `ssh:connect` fails → tabs for that target remain disconnected, user sees reconnect dialog |
| Network unreachable on startup | `ssh:connect` times out → existing retry/backoff kicks in, shows reconnecting status |
| Passphrase-protected key | Target deferred to on-demand reconnect at tab focus; passphrase dialog fires in context of the specific terminal |
| Multiple SSH targets | Non-passphrase targets reconnect eagerly in parallel via `Promise.allSettled`; passphrase targets deferred; partial success is fine |
| Per-target timeout exceeded | Target treated as failed after 15s; tabs show disconnected state with manual retry affordance |
| Crash (no beforeunload) | No session captured → same as today (no regression). Periodic save (future improvement) could mitigate |
| App update with relay version bump | Relay redeploy triggers naturally; old PTYs lost (acceptable — version change implies incompatibility) |

## Testing Strategy

### Unit Tests

- `workspace-session.test.ts`: Verify `buildWorkspaceSessionPayload` includes SSH fields when connections are active and omits them when none are
- `workspace-session-schema.test.ts`: Verify schema parses sessions with/without new optional fields
- `terminals.test.ts`: Verify `reconnectPersistedTerminals` processes SSH-backed tabs when connection is active and skips when not

### Integration Tests

- `store-session-cascades.test.ts`: Extend existing local daemon reattach test suite (lines 660-960) to cover SSH-backed tabs
- `terminal-restart-persistence.spec.ts`: Add E2E scenario for SSH terminal restore

### Manual Test Plan

1. Connect to SSH target with 2+ terminal tabs running long processes
2. Quit Orca
3. Relaunch within grace window → verify SSH reconnects, terminals show scrollback, processes still running
4. Quit Orca, wait past grace window, relaunch → verify SSH reconnects, terminals show "session expired" and spawn fresh shells
5. Quit Orca with passphrase-protected key → verify tabs show "Waiting for connection" overlay, focus a tab → verify passphrase dialog, enter passphrase → verify terminal restores
6. Kill Orca (force quit) → verify no crash on next launch (no session saved, clean fallback)

## Files to Modify

| File | Change |
|------|--------|
| `src/shared/types.ts` | Add `activeConnectionIdsAtShutdown`, `remoteSessionIdsByTabId` to `WorkspaceSessionState` |
| `src/shared/ssh-types.ts` | Add `relayGracePeriodSeconds` and `lastRequiredPassphrase` to `SshTarget` |
| `src/shared/workspace-session-schema.ts` | Add Zod schemas for new fields |
| `src/main/providers/ssh-pty-provider.ts` | Modify `spawn()` to detect `sessionId`, call `pty.attach` with try/catch fallback to `pty.spawn` |
| `src/main/providers/types.ts` | Add `sessionExpired?: boolean` to `PtySpawnResult` |
| `src/main/ipc/ssh-relay-helpers.ts` | Wire `onReplay` in `wireUpSshPtyEvents()` to forward replay data via dedicated `pty:replay` IPC channel |
| `src/preload/index.ts` | Add `pty.onReplay` binding for the new `pty:replay` IPC channel |
| `src/renderer/src/lib/pty-dispatcher.ts` | Add `pty:replay` handler that routes through replay-guarded `onReplayData` callback |
| `src/main/ipc/ssh.ts` | Set `lastRequiredPassphrase` on target after successful `ssh:connect` based on whether credential prompt was triggered |
| `src/renderer/src/lib/workspace-session.ts` | Add `sshConnectionStates`, `repos`, `worktreesByRepo` to snapshot; build `remoteSessionIdsByTabId` from renderer state |
| `src/renderer/src/App.tsx` | Add SSH reconnect pass (eager + deferred) before `reconnectPersistedTerminals()` |
| `src/renderer/src/store/slices/terminals.ts` | Remove SSH skip gate; merge remote session IDs into pending reconnect map; add `deferredSshReconnectTargets` state + actions |
| `src/main/ssh/ssh-relay-deploy.ts` | Pass configurable grace time to relay |
| `src/renderer/src/components/settings/SshTargetForm.tsx` | Add grace period setting UI |
